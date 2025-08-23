import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { parseFile } from 'music-metadata';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
const PORT = 8000;

// Создаем папку audio, если её нет
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR);
    console.log(`📁 Создана папка для аудио: ${AUDIO_DIR}`);
}

// Функция для получения IP-адреса сервера
function getServerIP() {
    const interfaces = os.networkInterfaces();
    for (const interfaceName of Object.keys(interfaces)) {
        for (const iface of interfaces[interfaceName]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const SERVER_IP = getServerIP();

// Проверяем установлен ли yt-dlp
async function checkYtDlp() {
    return new Promise((resolve) => {
        // Проверяем несколько возможных мест
        const checkCommands = [
            'test -f ~/yt-dlp && echo "home"',
            'which yt-dlp 2>/dev/null && echo "system"',
            'test -f /usr/local/bin/yt-dlp && echo "local"'
        ];
        
        exec(checkCommands.join(' || '), (error, stdout) => {
            if (stdout && stdout.trim()) {
                const location = stdout.trim();
                console.log(`✅ yt-dlp найден (${location})`);
                resolve(true);
            } else {
                console.log('❌ yt-dlp не найден. Скачайте:');
                console.log('wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O ~/yt-dlp');
                console.log('chmod +x ~/yt-dlp');
                resolve(false);
            }
        });
    });
}

async function safeDeleteFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Удален файл: ${filePath}`);
        }
    } catch (error) {
        console.error('❌ Ошибка удаления файла:', error);
    }
}

// Проверяем установлен ли ffmpeg
async function checkFfmpeg() {
    return new Promise((resolve) => {
        exec('which ffmpeg', (error) => {
            if (error) {
                console.log('❌ ffmpeg не установлен. Установите: sudo apt install ffmpeg');
                resolve(false);
            } else {
                console.log('✅ ffmpeg установлен');
                resolve(true);
            }
        });
    });
}

// Поиск трека на YouTube
async function searchYouTube(trackName) {
    try {
        console.log(`🔍 Ищем трек: "${trackName}"`);
        
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(trackName)}`;
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
            }
        });
        
        const html = await response.text();
        
        // Ищем videoId в HTML
        const regex = /"videoId":"([^"]{11})"/;
        const match = html.match(regex);
        
        if (match && match[1]) {
            const videoId = match[1];
            const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
            console.log(`✅ Найден видео: ${videoUrl}`);
            return videoUrl;
        }
        
        console.log('❌ Трек не найден');
        return null;
        
    } catch (error) {
        console.error('❌ Ошибка поиска:', error);
        return null;
    }
}

// Скачивание через yt-dlp
async function downloadYouTubeTrack(videoUrl, trackName) {
    return new Promise((resolve, reject) => {
        console.log(`📥 Скачиваем: ${videoUrl}`);
        
        const safeName = trackName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
        const outputTemplate = path.join(AUDIO_DIR, `${safeName}.%(ext)s`);
        
        // Проверяем где находится yt-dlp
        const ytDlpCommand = fs.existsSync(path.join(os.homedir(), 'yt-dlp')) ? 
            path.join(os.homedir(), 'yt-dlp') : 'yt-dlp';
        
        // Команда для yt-dlp
        const command = `${ytDlpCommand} -x --audio-format mp3 --audio-quality 0 -o "${outputTemplate}" "${videoUrl}"`;
        
        console.log(`▶️ Выполняем: ${command}`);
        
        exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Ошибка скачивания:', error);
                console.error('stderr:', stderr);
                reject(error);
                return;
            }
            
            console.log('✅ Скачивание завершено');
            
            // Ищем скачанный файл
            const files = fs.readdirSync(AUDIO_DIR);
            const newFile = files.find(f => f.startsWith(safeName) && f.endsWith('.mp3'));
            
            if (newFile) {
                const filePath = path.join(AUDIO_DIR, newFile);
                console.log(`📁 Файл найден: ${filePath}`);
                resolve(filePath);
            } else {
                console.error('❌ Скачанный файл не найден');
                reject(new Error('Файл не найден'));
            }
        });
    });
}

// Получаем список аудиофайлов с точными длительностями
async function getAudioFilesWithDurations() {
    try {
        const files = fs.readdirSync(AUDIO_DIR)
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext);
            })
            .map(file => path.join(AUDIO_DIR, file));

        const filesWithDurations = [];
        
        for (const filePath of files) {
            try {
                const metadata = await parseFile(filePath);
                const durationMs = metadata.format.duration ? Math.round(metadata.format.duration * 1000) : 180000;
                
                filesWithDurations.push({
                    path: filePath,
                    duration: durationMs,
                    name: path.basename(filePath, path.extname(filePath)),
                    isDownloaded: false // Статические файлы не удаляем
                });
                
            } catch (error) {
                console.error(`❌ Ошибка чтения метаданных ${filePath}:`, error);
                filesWithDurations.push({
                    path: filePath,
                    duration: 180000,
                    name: path.basename(filePath, path.extname(filePath)),
                    isDownloaded: false // Статические файлы не удаляем
                });
            }
        }
        
        return filesWithDurations;
    } catch (err) {
        console.error('❌ Ошибка чтения папки audio:', err);
        return [];
    }
}

// Глобальное состояние
let audioFilesCache = []; // Очередь треков
let queueStartTime = Date.now(); // Время начала воспроизведения очереди
let trackStartTimes = []; // Время начала каждого трека в очереди
let activeConnections = new Set();

// Функция для добавления трека в очередь (после текущего)
async function addTrackToQueue(trackName) {
    console.log(`🎵 Добавляем в очередь: "${trackName}"`);
    
    try {
        const hasYtDlp = await checkYtDlp();
        if (!hasYtDlp) throw new Error('yt-dlp не установлен');

        const videoUrl = await searchYouTube(trackName);
        if (!videoUrl) return false;

        const filePath = await downloadYouTubeTrack(videoUrl, trackName);
        if (!filePath) return false;

        let durationMs = 180000;
        try {
            const metadata = await parseFile(filePath);
            durationMs = metadata.format.duration ? Math.round(metadata.format.duration * 1000) : 180000;
        } catch (error) {
            console.error('❌ Ошибка длительности:', error);
        }

        const newTrack = {
            path: filePath,
            duration: durationMs,
            name: path.basename(filePath, path.extname(filePath)),
            isDownloaded: true
        };

        // Вставляем после текущего трека
        const currentTime = Date.now() - queueStartTime;
        let totalDuration = 0;
        let insertIndex = 0;
        
        for (let i = 0; i < audioFilesCache.length; i++) {
            if (currentTime < totalDuration + audioFilesCache[i].duration) {
                insertIndex = i + 1;
                break;
            }
            totalDuration += audioFilesCache[i].duration;
        }
        
        audioFilesCache.splice(insertIndex, 0, newTrack);
        
        // Пересчитываем временные метки для всех треков
        recalculateTrackStartTimes();
        
        console.log(`✅ Трек добавлен в позицию ${insertIndex + 1}: ${newTrack.name}`);
        console.log(`⏱️ Будет воспроизведен через ~${Math.round((totalDuration - currentTime) / 1000)} сек`);

        return true;
    } catch (error) {
        console.error('❌ Ошибка добавления:', error);
        return false;
    }
}

// Пересчет временных меток для всех треков
function recalculateTrackStartTimes() {
    trackStartTimes = [];
    let cumulativeTime = 0;
    
    for (let i = 0; i < audioFilesCache.length; i++) {
        trackStartTimes.push(cumulativeTime);
        cumulativeTime += audioFilesCache[i].duration;
    }
}

// Получаем текущий трек и позицию в нем
function getCurrentTrackInfo() {
    const currentTime = Date.now() - queueStartTime;
    let totalDuration = 0;
    
    for (let i = 0; i < audioFilesCache.length; i++) {
        if (currentTime < totalDuration + audioFilesCache[i].duration) {
            return {
                index: i,
                track: audioFilesCache[i],
                positionMs: currentTime - totalDuration
            };
        }
        totalDuration += audioFilesCache[i].duration;
    }
    
    // Если очередь пуста или мы прошли всю очередь
    return {
        index: 0,
        track: audioFilesCache[0],
        positionMs: 0
    };
}

// Отправляем трек с нужной позиции
function sendTrackFromPosition(res, track, positionMs) {
    if (!track || !fs.existsSync(track.path)) {
        console.error(`❌ Файл не существует: ${track ? track.path : 'undefined'}`);
        if (!res.finished) res.end();
        return;
    }

    // Убедимся, что позиция в пределах трека
    positionMs = Math.max(0, Math.min(positionMs, track.duration - 1000));
    
    const startSeconds = (positionMs / 1000).toFixed(3);
    const ffmpeg = exec(`ffmpeg -ss ${startSeconds} -i "${track.path}" -f mp3 -`, {
        maxBuffer: 10 * 1024 * 1024 // Увеличиваем буфер для длинных треков
    });

    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked'
    });

    ffmpeg.stdout.pipe(res, { end: false });

    ffmpeg.on('close', (code) => {
        if (track.isDownloaded && code === 0) {
            setTimeout(() => safeDeleteFile(track.path), 1000);
        }
        if (!res.finished) res.end();
    });

    // Игнорируем ошибки ffmpeg (для чистоты логов)
    ffmpeg.stderr.on('data', () => {});

    // Останавливаем ffmpeg при отключении клиента
    req.on('close', () => ffmpeg.kill());
}

// Загружаем файлы и запускаем таймер
getAudioFilesWithDurations().then(files => {
    audioFilesCache = files;
    console.log(`✅ Загружено ${files.length} треков`);
    
    if (files.length > 0) {
        console.log('\n🎵 Очередь:');
        files.forEach((f, i) => console.log(`${i+1}. ${f.name} (${Math.round(f.duration/1000)}с)`));
        recalculateTrackStartTimes();
        startPlaybackLoop();
    } else {
        console.log('⏸️ Очередь пуста, ждём треки...');
    }
}).catch(console.error);

// Запускаем циклическое воспроизведение
function startPlaybackLoop() {
    queueStartTime = Date.now();
    recalculateTrackStartTimes();

    function playNextTrack() {
        if (audioFilesCache.length === 0) {
            console.log('⏸️ Очередь пуста, проверяем через 5 секунд...');
            setTimeout(playNextTrack, 5000);
            return;
        }

        const { index, track, positionMs } = getCurrentTrackInfo();
        console.log(`\n🌐 Сейчас играет: ${track.name} (${Math.round(track.duration / 1000)}с), позиция: ${Math.round(positionMs / 1000)}с`);
        console.log(`📊 В очереди: ${audioFilesCache.length} треков`);

        // Обновляем очередь для всех активных соединений
        activeConnections.forEach(res => {
            if (!res.finished) {
                sendTrackFromPosition(res, track, positionMs);
            }
        });

        // Запускаем таймер до конца текущего трека
        const timeUntilNextTrack = track.duration - positionMs;
        setTimeout(playNextTrack, timeUntilNextTrack);
    }

    console.log('🚀 Воспроизведение запущено');
    playNextTrack();
}

// Сервер
const server = http.createServer(async (req, res) => {
    // POST роут для добавления трека
    if (req.url === '/add' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { track } = JSON.parse(body);
                if (!track) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: 'Нет названия' }));
                }

                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });
                res.end(JSON.stringify({ success: true, message: 'Трек в обработке' }));

                setTimeout(async () => {
                    await addTrackToQueue(track);
                }, 100);
            } catch (e) {
                res.writeHead(500).end('Ошибка');
            }
        });
        return;
    }

    // OPTIONS для CORS
    if (req.url === '/add' && req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    // Обслуживаем аудиопоток
    if (req.url === '/stream.mp3') {
        if (audioFilesCache.length === 0) {
            res.writeHead(500).end('Нет треков');
            return;
        }

        console.log(`🎧 Новый клиент подключился (всего: ${activeConnections.size + 1})`);
        activeConnections.add(res);

        // Получаем текущий трек и позицию
        const { track, positionMs } = getCurrentTrackInfo();

        // Отправляем поток с нужной позиции
        sendTrackFromPosition(res, track, positionMs);

        // Удаляем соединение при закрытии
        req.on('close', () => {
            console.log('🔌 Клиент отключился');
            activeConnections.delete(res);
        });
        
        res.on('finish', () => {
            activeConnections.delete(res);
        });

        return;
    }

    // Главная страница
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <h1>🎧 Highrise Radio</h1>
        <p>Добавить трек в очередь (после текущего):</p>
        <input type="text" id="trackInput" placeholder="Название трека">
        <button onclick="addTrack()">Добавить</button>
        <p id="status"></p>
        <audio controls>
            <source src="/stream.mp3" type="audio/mpeg">
        </audio>
        
        <script>
            async function addTrack() {
                const track = document.getElementById('trackInput').value;
                if (!track) return;
                
                const response = await fetch('/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ track })
                });
                
                const result = await response.json();
                document.getElementById('status').textContent = result.message;
                document.getElementById('trackInput').value = '';
            }
        </script>
    `);
});

// Запуск
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Стрим: http://${SERVER_IP}:${PORT}/stream.mp3
➕ Добавить: POST http://${SERVER_IP}:${PORT}/add

📁 Аудио: ${AUDIO_DIR}
🌐 IP: ${SERVER_IP}
`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Выключение...');
    activeConnections.forEach(res => res.end());
    process.exit();
});