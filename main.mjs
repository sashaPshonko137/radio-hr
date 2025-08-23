import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// В начале файла добавьте
import os from 'os';

// Проверяем доступность yt-dlp при старте
async function initialize() {
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) {
        console.log('💡 Для скачивания треков выполните:');
        console.log('wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O ~/yt-dlp');
        console.log('chmod +x ~/yt-dlp');
    }
    
    // ... остальная инициализация
}
import { parseFile } from 'music-metadata';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
const PORT = 8000;

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
            console.log(`🗑️  Удален файл: ${filePath}`);
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
        
        console.log(`▶️  Выполняем: ${command}`);
        
        exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
            // ... остальной код без изменений
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
                    name: path.basename(filePath, path.extname(filePath))
                });
                
            } catch (error) {
                console.error(`❌ Ошибка чтения метаданных ${filePath}:`, error);
                filesWithDurations.push({
                    path: filePath,
                    duration: 180000,
                    name: path.basename(filePath, path.extname(filePath))
                });
            }
        }
        
        return filesWithDurations;
    } catch (err) {
        console.error('Ошибка чтения папки audio:', err);
        return [];
    }
}

// Глобальное состояние для синхронизации
let audioFilesCache = [];
let currentTrackIndex = 0;
let trackStartTime = Date.now();
let activeConnections = new Set();

// Функция для добавления трека в очередь (после текущего)
// Функция для добавления трека в очередь (после текущего)
async function addTrackToQueue(trackName) {
    console.log(`🎵 Добавляем в очередь: "${trackName}"`);
    
    try {
        // Проверяем зависимости
        const hasYtDlp = await checkYtDlp();
        if (!hasYtDlp) {
            throw new Error('yt-dlp не установлен');
        }

        // Ищем трек на YouTube
        const videoUrl = await searchYouTube(trackName);
        if (!videoUrl) {
            console.log('❌ Трек не найден');
            return false;
        }
        
        // Скачиваем трек
        const filePath = await downloadYouTubeTrack(videoUrl, trackName);
        if (!filePath) {
            console.log('❌ Не удалось скачать трек');
            return false;
        }
        
        // Получаем длительность
        let durationMs = 180000;
        try {
            const metadata = await parseFile(filePath);
            durationMs = metadata.format.duration ? Math.round(metadata.format.duration * 1000) : 180000;
        } catch (error) {
            console.error('❌ Ошибка чтения длительности:', error);
        }
        
        const newTrack = {
            path: filePath,
            duration: durationMs,
            name: path.basename(filePath, path.extname(filePath)),
            isDownloaded: true // Помечаем как скачанный для последующего удаления
        };
        
        // Добавляем трек СРАЗУ ПОСЛЕ ТЕКУЩЕГО
        const insertIndex = currentTrackIndex + 1;
        audioFilesCache.splice(insertIndex, 0, newTrack);
        
        console.log(`✅ Трек добавлен в позицию ${insertIndex + 1}: ${newTrack.name}`);
        console.log(`⏱️  Будет воспроизведен после текущего трека`);
        
        return true;
        
    } catch (error) {
        console.error('❌ Ошибка добавления трека:', error);
        return false;
    }
}

// Предзагружаем информацию о файлах
getAudioFilesWithDurations().then(files => {
    audioFilesCache = files;
    console.log(`✅ Загружено ${files.length} треков с точными длительностями`);
    
    console.log('\n🎵 Порядок воспроизведения:');
    audioFilesCache.forEach((track, index) => {
        console.log(`${index + 1}. ${track.name} (${Math.round(track.duration / 1000)} сек)`);
    });
    
    startGlobalTrackTimer();
}).catch(err => {
    console.error('❌ Ошибка загрузки треков:', err);
});

// Глобальный таймер для смены треков
function startGlobalTrackTimer() {
    if (audioFilesCache.length === 0) return;

    function playNextTrack() {
        const track = audioFilesCache[currentTrackIndex];
        trackStartTime = Date.now();
        
        console.log(`\n🌐 Сейчас играет: ${track.name} (${Math.round(track.duration / 1000)} сек)`);
        
        activeConnections.forEach(res => {
            if (!res.finished) {
                sendTrackFromPosition(res, track, 0);
            }
        });

        setTimeout(playNextTrack, track.duration);
        
        currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
    }

    console.log(`\n🚀 Начинаем воспроизведение`);
    playNextTrack();
}

// Отправка трека с определенной позиции
function sendTrackFromPosition(res, track, positionMs) {
    if (positionMs >= track.duration) {
        positionMs = 0;
    }

    if (!fs.existsSync(track.path)) {
        console.error(`❌ Файл не существует: ${track.path}`);
        if (!res.finished) {
            res.end();
        }
        return;
    }

    const readStream = fs.createReadStream(track.path);
    
    if (positionMs > 0) {
        const bytesToSkip = Math.floor((positionMs / 1000) * 16000);
        let bytesSkipped = 0;
        
        readStream.on('data', (chunk) => {
            if (bytesSkipped < bytesToSkip) {
                bytesSkipped += chunk.length;
                if (bytesSkipped >= bytesToSkip) {
                    const remainingChunk = chunk.slice(bytesToSkip - (bytesSkipped - chunk.length));
                    if (remainingChunk.length > 0 && !res.finished) {
                        res.write(remainingChunk);
                    }
                }
            } else {
                if (!res.finished) {
                    res.write(chunk);
                }
            }
        });
    } else {
        readStream.pipe(res, { end: false });
    }

    readStream.on('end', () => {
        // Удаляем файл ПОСЛЕ завершения отправки
        if (track.path.includes(AUDIO_DIR)) {
            setTimeout(() => safeDeleteFile(track.path), 1000);
        }
    });

    readStream.on('error', (err) => {
        console.error('❌ Ошибка отправки трека:', err);
        if (!res.finished) {
            res.end();
        }
    });
}

// Создаём сервер
// Создаём сервер
const server = http.createServer(async (req, res) => {
    // POST роут для добавления трека
    if (req.url === '/add' && req.method === 'POST') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                const { track } = JSON.parse(body);
                
                if (!track) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Не указано название трека' }));
                    return;
                }
                
                console.log(`📨 POST запрос на добавление: "${track}"`);
                
                // НЕМЕДЛЕННО отвечаем клиенту
                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });
                
                res.end(JSON.stringify({ 
                    success: true, 
                    message: 'Трек принят в обработку' 
                }));
                
                // Асинхронно обрабатываем скачивание (после ответа клиенту)
                setTimeout(async () => {
                    try {
                        const success = await addTrackToQueue(track);
                        console.log(success ? '✅ Трек добавлен' : '❌ Ошибка добавления');
                    } catch (error) {
                        console.error('❌ Ошибка обработки трека:', error);
                    }
                }, 100);
                
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Ошибка сервера' }));
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
        res.end();
        return;
    }

     // Обслуживаем аудиопоток
    if (req.url === '/stream.mp3') {
        if (audioFilesCache.length === 0) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Нет аудиофайлов');
            return;
        }

        console.log(`🎧 Новый клиент подключился (всего: ${activeConnections.size + 1})`);
        activeConnections.add(res);

        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });

        const currentTrack = audioFilesCache[currentTrackIndex];
        const elapsed = Date.now() - trackStartTime;
        const positionMs = Math.min(elapsed, currentTrack.duration - 1000);

        sendTrackFromPosition(res, currentTrack, positionMs);

        req.on('close', () => {
            console.log('🎧 Клиент отключился');
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
            }
        </script>
    `);
});

// Запускаем сервер
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise: http://${SERVER_IP}:${PORT}/stream.mp3
➕ Добавить трек: POST http://${SERVER_IP}:${PORT}/add

📁 Аудиофайлы из папки: ${AUDIO_DIR}
🌐 Сервер доступен по IP: ${SERVER_IP}

💡 Для работы скачивания установи:
sudo apt update && sudo apt install yt-dlp ffmpeg
`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Выключаем сервер...');
    activeConnections.forEach(res => {
        if (!res.finished) res.end();
    });
    process.exit(0);
});