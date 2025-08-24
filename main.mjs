import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { setMaxListeners } from 'events';
import { parseFile } from 'music-metadata';
import { exec } from 'child_process';
import { createConnection } from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
const PORT = 8008;
const ICECAST_PORT = 8000;
const CACHE_DIR = path.join(__dirname, 'cache');

let icecastSocket = null;  // Обратите внимание на регистр: Socket с заглавной S
let icecastConnected = false;

setMaxListeners(50);

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`📁 Создана папка кэша: ${CACHE_DIR}`);
}

async function getCacheFileName(url) {
    const videoIdMatch = url.match(/v=([a-zA-Z0-9_-]{11})/);
    
    if (videoIdMatch && videoIdMatch[1]) {
        return `youtube_${videoIdMatch[1]}.mp3`;
    }
    
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return `track_${hash}.mp3`;
}

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

async function checkYtDlp() {
    return new Promise((resolve) => {
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

// Поиск трека на YouTube (без изменений)
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

// Скачивание через yt-dlp (без изменений)
async function downloadYouTubeTrack(videoUrl, trackName) {
    try {
        const cacheFileName = await getCacheFileName(videoUrl);
        const cacheFilePath = path.join(CACHE_DIR, cacheFileName);
        
        if (fs.existsSync(cacheFilePath)) {
            console.log(`✅ Используем кэшированный трек: ${cacheFilePath}`);
            return cacheFilePath;
        }
        
        console.log(`📥 Скачиваем: ${videoUrl}`);
        
        const ytDlpCommand = fs.existsSync(path.join(os.homedir(), 'yt-dlp')) ? 
            path.join(os.homedir(), 'yt-dlp') : 'yt-dlp';
        
        const command = `${ytDlpCommand} -x --audio-format mp3 --audio-quality 0 -o "${cacheFilePath}" "${videoUrl}"`;
        
        console.log(`▶️  Выполняем: ${command}`);
        
        return new Promise((resolve, reject) => {
            exec(command, { timeout: 120000 }, (error, stdout, stderr) => {
                if (error) {
                    console.error('❌ Ошибка скачивания:', error);
                    console.error('stderr:', stderr);
                    reject(error);
                    return;
                }
                
                console.log('✅ Скачивание завершено');
                
                if (fs.existsSync(cacheFilePath)) {
                    console.log(`📁 Файл сохранен в кэш: ${cacheFilePath}`);
                    resolve(cacheFilePath);
                } else {
                    console.error('❌ Скачанный файл не найден');
                    reject(new Error('Файл не найден'));
                }
            });
        });
    } catch (error) {
        console.error('❌ Ошибка подготовки к скачиванию:', error);
        throw error;
    }
}

async function scanDirectory(dir, isCached) {
    try {
        if (!fs.existsSync(dir)) {
            return [];
        }
        
        const files = fs.readdirSync(dir)
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext);
            })
            .map(file => path.join(dir, file));

        const filesWithDurations = [];
        
        for (const filePath of files) {
            try {
                const metadata = await parseFile(filePath);
                const durationMs = metadata.format.duration ? Math.round(metadata.format.duration * 1000) : 180000;
                
                filesWithDurations.push({
                    path: filePath,
                    duration: durationMs,
                    name: path.basename(filePath, path.extname(filePath)),
                    isDownloaded: isCached,
                    sourceUrl: isCached ? extractUrlFromCacheName(filePath) : null
                });
                
            } catch (error) {
                console.error(`❌ Ошибка чтения метаданных ${filePath}:`, error);
                filesWithDurations.push({
                    path: filePath,
                    duration: 180000,
                    name: path.basename(filePath, path.extname(filePath)),
                    isDownloaded: isCached,
                    sourceUrl: isCached ? extractUrlFromCacheName(filePath) : null
                });
            }
        }
        
        return filesWithDurations;
    } catch (err) {
        console.error(`Ошибка чтения папки ${dir}:`, err);
        return [];
    }
}

function extractUrlFromCacheName(filePath) {
    const fileName = path.basename(filePath);
    
    const youtubeMatch = fileName.match(/youtube_([a-zA-Z0-9_-]{11})\.mp3/);
    if (youtubeMatch && youtubeMatch[1]) {
        return `https://www.youtube.com/watch?v=${youtubeMatch[1]}`;
    }
    
    return null;
}

getAudioFilesWithDurations().then(files => {
    audioFilesCache = files;
    console.log(`✅ Загружено ${files.length} статических треков`);
    
    console.log('\n🎵 Порядок воспроизведения:');
    audioFilesCache.forEach((track, index) => {
        console.log(`${index + 1}. ${track.name} (${Math.round(track.duration / 1000)} сек)`);
    });
    
    // УБРАЛИ ЭТУ СТРОКУ:
    // connectToIcecast();
    
    // Запускаем воспроизведение, если есть треки
    if (audioFilesCache.length > 0) {
        console.log('\n🚀 Начинаем воспроизведение');
        playNextTrack(); // ТЕПЕРЬ ПОДКЛЮЧЕНИЕ БУДЕТ ТОЛЬКО ОДНО
    }
}).catch(err => {
    console.error('❌ Ошибка загрузки треков:', err);
});

// Глобальное состояние для очереди
let audioFilesCache = [];
let currentTrackIndex = 0;
let icecastStream = null;
let isStreaming = false;
let nextTrackTimeout = null;

// Подключение к Icecast
// Подключение к Icecast
function connectToIcecast() {
    // Закрываем предыдущее соединение, если оно есть
    if (icecastSocket) {
        icecastSocket.destroy();
        icecastSocket = null;
    }
    
    console.log(`📡 Пытаемся подключиться к Icecast: localhost:${ICECAST_PORT}`);
    
    // Создаем TCP-соединение с Icecast
    icecastSocket = createConnection(ICECAST_PORT, 'localhost', () => {
        console.log('✅ Установлено соединение с Icecast');
        
        // Отправляем заголовки аутентификации
        const headers = [
            `SOURCE /highrise-radio.mp3 HTTP/1.0`,
            `Authorization: Basic ${Buffer.from('source:hackme').toString('base64')}`,
            `Content-Type: audio/mpeg`,
            `User-Agent: HighriseRadio/1.0`,
            ``
        ].join('\r\n');
        
        icecastSocket.write(headers);
    });
    
    // Обработка данных от Icecast
    icecastSocket.on('data', (data) => {
        const response = data.toString();
        console.log(`📨 Ответ от Icecast: ${response.split('\n')[0]}`);
        
        // Проверяем успешное подключение
        if (response.includes('200 OK')) {
            console.log('🎉 Успешная аутентификация с Icecast');
            icecastConnected = true;
            isStreaming = true;
            
            // Отправляем трек ТОЛЬКО ПОСЛЕ УСПЕШНОЙ АУТЕНТИФИКАЦИИ
            sendTrackToIcecast();
        } else if (response.includes('401 Unauthorized')) {
            console.error('❌ Ошибка аутентификации с Icecast. Проверьте пароль!');
            icecastConnected = false;
            isStreaming = false;
            
            // ЗАКРЫВАЕМ СОЕДИНЕНИЕ ПРИ ОШИБКЕ
            if (icecastSocket) {
                icecastSocket.end();
                icecastSocket = null;
            }
        }
    });
    
    // УБЕРАЙТЕ ЭТИ ОБРАБОТЧИКИ - ОНИ ВЫЗЫВАЮТ БЕСКОНЕЧНЫЙ ЦИКЛ
    // icecastSocket.on('error', ...) 
    // icecastSocket.on('close', ...)
    
    return icecastSocket;
}

// Отправка трека в Icecast (вызывается ТОЛЬКО после успешной аутентификации)
function sendTrackToIcecast() {
    const track = audioFilesCache[currentTrackIndex];
    const readStream = fs.createReadStream(track.path);
    
    readStream.pipe(icecastSocket, { end: false });
    
    readStream.on('end', () => {
        console.log(`⏹️  Трек завершен: ${track.name}`);
        
        // ЗАКРЫВАЕМ СОЕДИНЕНИЕ С ICECAST
        if (icecastSocket) {
            icecastSocket.end();
            icecastSocket = null;
        }
        
        icecastConnected = false;
        isStreaming = false;
        
        // Удаляем скачанный трек после воспроизведения
        if (track.isDownloaded) {
            console.log(`🗑️  Удаляем временный трек после воспроизведения: ${track.name}`);
            audioFilesCache.splice(currentTrackIndex, 1);
            
            if (currentTrackIndex >= audioFilesCache.length && audioFilesCache.length > 0) {
                currentTrackIndex = 0;
            }
        } else {
            currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
        }
        
        // ЗАПУСКАЕМ СЛЕДУЮЩИЙ ТРЕК
        playNextTrack();
    });
    
    readStream.on('error', (err) => {
        console.error('❌ Ошибка отправки трека в Icecast:', err);
        
        // ЗАКРЫВАЕМ СОЕДИНЕНИЕ ПРИ ОШИБКЕ
        if (icecastSocket) {
            icecastSocket.end();
            icecastSocket = null;
        }
        
        icecastConnected = false;
        isStreaming = false;
        
        // Пропускаем этот трек и переходим к следующему
        if (track.isDownloaded) {
            audioFilesCache.splice(currentTrackIndex, 1);
        } else {
            currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
        }
        
        // ЗАПУСКАЕМ СЛЕДУЮЩИЙ ТРЕК
        playNextTrack();
    });
}

async function addTrackToQueue(trackName) {
    console.log(`🎵 Добавляем в очередь: "${trackName}"`);
    
    try {
        const hasYtDlp = await checkYtDlp();
        if (!hasYtDlp) {
            throw new Error('yt-dlp не установлен');
        }

        const videoUrl = await searchYouTube(trackName);
        if (!videoUrl) {
            console.log('❌ Трек не найден');
            return false;
        }
        
        // Проверяем, не добавлен ли уже этот URL в очередь
        const isDuplicateInQueue = audioFilesCache.some(track => 
            track.sourceUrl && track.sourceUrl === videoUrl
        );
        
        // Проверяем, существует ли уже файл в кэше
        const cacheFileName = await getCacheFileName(videoUrl);
        const cacheFilePath = path.join(CACHE_DIR, cacheFileName);
        const isAlreadyCached = fs.existsSync(cacheFilePath);
        
        if (isDuplicateInQueue) {
            console.log(`⚠️  Трек с этим URL уже в очереди: ${videoUrl}`);
            return false;
        }
        
        if (isAlreadyCached) {
            console.log(`✅ Трек уже в кэше: ${cacheFilePath}`);
        }
        
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
            isDownloaded: true,
            sourceUrl: videoUrl
        };
        
        // Добавляем в очередь
        let insertIndex;
        if (audioFilesCache.length === 0) {
            insertIndex = 0;
        } else {
            insertIndex = (currentTrackIndex + 1) % (audioFilesCache.length + 1);
        }
        
        audioFilesCache.splice(insertIndex, 0, newTrack);
        
        console.log(`✅ Трек добавлен в позицию ${insertIndex + 1}: ${newTrack.name}`);
        console.log(`🔗 Источник: ${videoUrl}`);
        
        // Если сейчас ничего не играет, запускаем воспроизведение
        if (!isStreaming && audioFilesCache.length > 0) {
            console.log('▶️ Немедленный запуск первого трека');
            playNextTrack();
        }
        
        return true;
        
    } catch (error) {
        console.error('❌ Ошибка добавления трека:', error);
        return false;
    }
}

// Запускаем воспроизведение
function playNextTrack() {
    // Очищаем предыдущий таймаут
    if (nextTrackTimeout) {
        clearTimeout(nextTrackTimeout);
        nextTrackTimeout = null;
    }
    
    // Проверяем, есть ли треки в очереди
    if (audioFilesCache.length === 0) {
        console.log('⏸️  Очередь пуста, ждем треки...');
        isStreaming = false;
        return;
    }
    
    // Корректируем индекс
    if (currentTrackIndex < 0 || currentTrackIndex >= audioFilesCache.length) {
        currentTrackIndex = 0;
    }
    
    const track = audioFilesCache[currentTrackIndex];
    
    if (!track) {
        console.error('❌ Трек не найден в позиции', currentTrackIndex);
        currentTrackIndex = 0;
        if (audioFilesCache.length > 0) {
            setTimeout(playNextTrack, 1000);
        }
        return;
    }
    
    console.log(`\n🌐 Сейчас играет: ${track.name} (${Math.round(track.duration / 1000)} сек)`);
    console.log(`📊 В очереди: ${audioFilesCache.length} треков`);
    
    // ЗАКРЫВАЕМ СТАРОЕ СОЕДИНЕНИЕ, ЕСЛИ ОНО ЕСТЬ
    if (icecastSocket) {
        icecastSocket.end();
        icecastSocket = null;
    }
    
    // ПОДКЛЮЧАЕМСЯ К ICECAST ТОЛЬКО КОГДА НУЖНО ОТПРАВИТЬ ТРЕК
    connectToIcecast();
}

// Создаем сервер
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
                
                // Асинхронно обрабатываем добавление трека
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

    // Обслуживаем аудиопоток - просто перенаправляем на Icecast
    if (req.url === '/stream.mp3') {
        const icecastUrl = `http://${SERVER_IP}:${ICECAST_PORT}/highrise-radio.mp3`;
        
        console.log(`🎧 Перенаправляем клиента на Icecast: ${icecastUrl}`);
        
        // 302 редирект на Icecast
        res.writeHead(302, {
            'Location': icecastUrl,
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.end();
        
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

// Загружаем статические треки и запускаем воспроизведение
getAudioFilesWithDurations().then(files => {
    audioFilesCache = files;
    console.log(`✅ Загружено ${files.length} статических треков`);
    
    console.log('\n🎵 Порядок воспроизведения:');
    audioFilesCache.forEach((track, index) => {
        console.log(`${index + 1}. ${track.name} (${Math.round(track.duration / 1000)} сек)`);
    });
    
    // Подключаемся к Icecast
    // connectToIcecast();
    
    // Запускаем воспроизведение, если есть треки
    if (audioFilesCache.length > 0) {
        console.log('\n🚀 Начинаем воспроизведение');
        playNextTrack();
    }
}).catch(err => {
    console.error('❌ Ошибка загрузки треков:', err);
});

// Запускаем сервер
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise: http://${SERVER_IP}:${ICECAST_PORT}/highrise-radio.mp3
➕ Добавить трек: POST http://${SERVER_IP}:${PORT}/add

📁 Аудиофайлы из папки: ${AUDIO_DIR}
🌐 Сервер доступен по IP: ${SERVER_IP}

💡 Для работы установи:
sudo apt update && sudo apt install icecast2 yt-dlp ffmpeg

ℹ️ Настройте Icecast (файл /etc/icecast2/icecast.xml):
- source-password: radio
- Порт: ${ICECAST_PORT}
- Mount point: /highrise-radio.mp3
`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Выключаем сервер...');
    
    // Закрываем соединение с Icecast
    if (icecastStream) {
        icecastStream.end();
    }
    
    process.exit(0);
});