import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { parseFile } from 'music-metadata';
import { exec } from 'child_process';
import { createConnection } from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
const PORT = 8008;
const ICECAST_PORT = 8000;
const CACHE_DIR = path.join(__dirname, 'cache');
const ICECAST_PASSWORD = 'hackme';
const SILENCE_CHUNK = Buffer.alloc(8192, 0);

let icecastSocket = null;
let icecastConnected = false;
let audioFilesCache = [];
let currentTrackIndex = 0;
let isStreaming = false;

let currentTrackBuffer = null;
let nextTrackBuffer = null;
let nextTrackInfo = null; // { path, duration, bitrate, name, isDownloaded }

// После добавления трека или загрузки очереди — предзагрузи следующий
async function preloadNextTrack() {
    const nextIndex = (currentTrackIndex + 1) % audioFilesCache.length;
    if (audioFilesCache.length < 2) return;

    const nextTrack = audioFilesCache[nextIndex];
    try {
        const data = await fs.promises.readFile(nextTrack.path);
        nextTrackBuffer = data;
        nextTrackInfo = { ...nextTrack };
        console.log(`✅ Предзагружен следующий трек: ${nextTrack.name}`);
    } catch (err) {
        console.error(`❌ Не удалось предзагрузить: ${nextTrack.path}`);
    }
}

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`📁 Создана папка кэша: ${CACHE_DIR}`);
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

async function getCacheFileName(url) {
    const videoIdMatch = url.match(/v=([a-zA-Z0-9_-]{11})/);
    if (videoIdMatch && videoIdMatch[1]) {
        return `youtube_${videoIdMatch[1]}.mp3`;
    }
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return `track_${hash}.mp3`;
}

async function checkYtDlp() {
    return new Promise((resolve) => {
        const checkCommands = [
            'test -f ~/yt-dlp && echo "home"',
            'which yt-dlp 2>/dev/null && echo "system"',
            'test -f /usr/local/bin/yt-dlp && echo "local"'
        ];
        exec(checkCommands.join(' || '), (error, stdout) => {
            if (stdout && stdout.trim()) {
                console.log(`✅ yt-dlp найден (${stdout.trim()})`);
                resolve(true);
            } else {
                console.log('❌ yt-dlp не найден. Установите:');
                console.log('wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O ~/yt-dlp && chmod +x ~/yt-dlp');
                resolve(false);
            }
        });
    });
}

async function searchYouTube(trackName) {
    try {
        const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(trackName)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const html = await response.text();
        const match = html.match(/"videoId":"([^"]{11})"/);
        return match ? `https://www.youtube.com/watch?v=${match[1]}` : null;
    } catch (error) {
        console.error('❌ Ошибка поиска:', error);
        return null;
    }
}

async function downloadYouTubeTrack(videoUrl) {
    const cacheFileName = await getCacheFileName(videoUrl);
    const cacheFilePath = path.join(CACHE_DIR, cacheFileName);
    if (fs.existsSync(cacheFilePath)) return cacheFilePath;

    const ytDlpCommand = fs.existsSync(`${os.homedir()}/yt-dlp`) ? `${os.homedir()}/yt-dlp` : 'yt-dlp';
    const command = `${ytDlpCommand} -x --audio-format mp3 --audio-quality 0 -o "${cacheFilePath}" "${videoUrl}"`;

    return new Promise((resolve, reject) => {
        exec(command, { timeout: 120000 }, (error) => {
            error ? reject(error) : resolve(cacheFilePath);
        });
    });
}

async function scanDirectory(dir, isCached) {
    if (!fs.existsSync(dir)) return [];
    
    return (await fs.promises.readdir(dir))
        .filter(file => ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(path.extname(file).toLowerCase()))
        .map(file => path.join(dir, file))
        .map(async filePath => {
            try {
                const metadata = await parseFile(filePath);
                const duration = metadata.format.duration 
                    ? Math.round(metadata.format.duration * 1000) 
                    : 180000;
                
                const bitrate = metadata.format.bitrate 
                    ? Math.round(metadata.format.bitrate) 
                    : 128000;

                return {
                    path: filePath,
                    duration,
                    bitrate,
                    name: path.basename(filePath, path.extname(filePath)),
                    isDownloaded: isCached,
                    sourceUrl: isCached ? extractUrlFromCacheName(filePath) : null
                };
            } catch (error) {
                console.error(`❌ Ошибка метаданных ${filePath}:`, error.message);
                return {
                    path: filePath,
                    duration: 180000,
                    bitrate: 128000,
                    name: path.basename(filePath, path.extname(filePath)),
                    isDownloaded: isCached,
                    sourceUrl: isCached ? extractUrlFromCacheName(filePath) : null
                };
            }
        });
}

function extractUrlFromCacheName(filePath) {
    const match = path.basename(filePath).match(/youtube_([a-zA-Z0-9_-]{11})\.mp3/);
    return match ? `https://www.youtube.com/watch?v=${match[1]}` : null;
}

async function getAudioFilesWithDurations() {
    const [staticFiles, cachedFiles] = await Promise.all([
        scanDirectory(AUDIO_DIR, false),
        scanDirectory(CACHE_DIR, true)
    ]);
    return (await Promise.all([...staticFiles, ...cachedFiles])).filter(Boolean);
}

// =============== ПОДКЛЮЧЕНИЕ К ICECAST ===============

function connectToIcecast() {
    if (icecastSocket) {
        icecastSocket.destroy();
        icecastSocket = null;
    }

    console.log(`📡 Подключаемся к Icecast: localhost:${ICECAST_PORT}`);
    icecastSocket = createConnection(ICECAST_PORT, 'localhost');

    let responseBuffer = '';

    icecastSocket
        .on('connect', () => {
            console.log('✅ Соединение с Icecast установлено');
            const auth = Buffer.from(`source:${ICECAST_PASSWORD}`).toString('base64');
            const headers = [
                `SOURCE /highrise-radio.mp3 HTTP/1.0`,
                `Authorization: Basic ${auth}`,
                'Content-Type: audio/mpeg',
                'User-Agent: HighriseRadio/1.0',
                '',
                ''
            ].join('\r\n');
            icecastSocket.write(headers);
        })
        .on('data', (data) => {
            responseBuffer += data.toString();
            if (responseBuffer.includes('\r\n\r\n')) {
                const status = responseBuffer.split('\n')[0].trim();
                console.log(`📨 Ответ от Icecast: ${status}`);
                if (status.includes('200 OK')) {
                    console.log('🎉 Успешная аутентификация');
                    icecastConnected = true;
                    isStreaming = true;
                    startNextTrack();
                } else if (status.includes('401 Unauthorized')) {
                    console.error('❌ Неверный пароль!');
                    icecastConnected = false;
                    setTimeout(connectToIcecast, 5000);
                }
            }
        })
        .on('error', (err) => {
            console.error('❌ Ошибка Icecast:', err.message);
            icecastConnected = false;
            isStreaming = false;
            setTimeout(connectToIcecast, 5000);
        })
        .on('close', () => {
            console.log('🔌 Соединение с Icecast закрыто');
            icecastConnected = false;
            isStreaming = false;
            setTimeout(connectToIcecast, 2000);
        });
}

function startNextTrack() {
    if (!isStreaming || !icecastConnected || audioFilesCache.length === 0) {
        console.log('⏸️  Очередь пуста');
        return;
    }

    // Корректируем индекс
    currentTrackIndex = currentTrackIndex % audioFilesCache.length;

    // Если есть предзагруженный — используем
    if (nextTrackBuffer && nextTrackInfo) {
        const buffer = nextTrackBuffer;
        const track = nextTrackInfo;
        nextTrackBuffer = null;
        nextTrackInfo = null;

        console.log(`🎵 Начинаем: ${track.name}`);
        playFromBuffer(buffer, track, () => {
            // Удаляем скачанный трек
            if (track.isDownloaded) {
                try {
                    fs.unlinkSync(track.path);
                    const idx = audioFilesCache.findIndex(t => t.path === track.path);
                    if (idx !== -1) audioFilesCache.splice(idx, 1);
                } catch (err) {}
            }
            // Запускаем следующий
            startNextTrack();
        });

        // Предзагружаем следующий
        setTimeout(preloadNextTrack, 100);
        return;
    }

    // Иначе — читаем с диска
    const track = audioFilesCache[currentTrackIndex];
    console.log(`🎵 Начинаем: ${track.name}`);

    fs.promises.readFile(track.path)
        .then(buffer => {
            playFromBuffer(buffer, track, () => {
                if (track.isDownloaded) {
                    try {
                        fs.unlinkSync(track.path);
                        audioFilesCache.splice(currentTrackIndex, 1);
                        if (currentTrackIndex >= audioFilesCache.length) currentTrackIndex = 0;
                    } catch (err) {}
                } else {
                    currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
                }
                startNextTrack();
            });
        })
        .catch(err => {
            console.error(`❌ Ошибка: ${track.path}`, err.message);
            currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
            startNextTrack();
        });

    // Предзагружаем следующий
    setTimeout(preloadNextTrack, 100);
}

function playFromBuffer(buffer, track, callback) {
    const chunkSize = 8192;
    let offset = 0;
    const bytesPerSecond = track.bitrate ? Math.round(track.bitrate / 8) : 16000;
    const startTime = Date.now();

    function sendChunk() {
        if (offset >= buffer.length) {
            console.log(`⏹️  Трек завершён: ${track.name}`);
            callback();
            return;
        }

        const chunk = buffer.slice(offset, offset + chunkSize);
        offset += chunk.length;

        if (icecastSocket && icecastSocket.writable) {
            icecastSocket.write(chunk);
        }

        const expectedTime = (offset / bytesPerSecond) * 1000;
        const realTime = Date.now() - startTime;
        const delay = Math.max(0, expectedTime - realTime);

        setTimeout(sendChunk, delay);
    }

    sendChunk();
}

function playCurrentTrack(callback) {
    const track = audioFilesCache[currentTrackIndex];
    if (!track) {
        callback();
        return;
    }

    console.log(`🎵 Играем: ${track.name}`);

    let fd;
    try {
        fd = fs.openSync(track.path, 'r');
    } catch (err) {
        console.error(`❌ Не удалось открыть: ${track.path}`);
        callback();
        return;
    }

    const chunkSize = 8192;
    const buffer = Buffer.alloc(chunkSize);
    const bytesPerSecond = track.bitrate ? Math.round(track.bitrate / 8) : 16000;
    const startTime = Date.now();
    let totalBytesSent = 0;

    function sendChunk() {
        try {
            const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, null);
            if (bytesRead > 0) {
                const chunk = buffer.slice(0, bytesRead);
                if (icecastSocket && icecastSocket.writable) {
                    icecastSocket.write(chunk);
                }

                totalBytesSent += bytesRead;
                const expectedTime = (totalBytesSent / bytesPerSecond) * 1000;
                const realTime = Date.now() - startTime;
                const delay = Math.max(0, expectedTime - realTime);

                setTimeout(sendChunk, delay);
            } else {
                fs.closeSync(fd);
                console.log(`⏹️  Трек завершён: ${track.name}`);

                // Удаляем временный трек
                if (track.isDownloaded) {
                    try {
                        fs.unlinkSync(track.path);
                        audioFilesCache.splice(currentTrackIndex, 1);
                        if (currentTrackIndex >= audioFilesCache.length) {
                            currentTrackIndex = 0;
                        }
                    } catch (err) {
                        console.error('❌ Не удалось удалить:', err);
                    }
                }

                callback(); // → следующий трек
            }
        } catch (err) {
            if (fd) fs.closeSync(fd);
            callback();
        }
    }

    sendChunk();
}

// =============== ОТПРАВКА ТРЕКА С ОЖИДАНИЕМ ПО ДЛИТЕЛЬНОСТИ ===============

function startStream() {
    if (!icecastConnected) {
        console.log('❌ Нет подключения к Icecast');
        setTimeout(startStream, 1000);
        return;
    }

    isStreaming = true;
    console.log('🔊 Запущен постоянный поток');

    // Бесконечный цикл отправки
    function sendContinuousData() {
        if (!isStreaming || !icecastConnected) return;

        if (audioFilesCache.length > 0 && currentTrackIndex < audioFilesCache.length) {
            // Есть трек — играем
            playCurrentTrack(() => {
                // После завершения — сразу следующий
                currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
                sendContinuousData();
            });
        } else {
            // Очередь пуста — отправляем тишину
            if (icecastSocket && icecastSocket.writable) {
                icecastSocket.write(SILENCE_CHUNK);
            }
            setTimeout(sendContinuousData, 500); // каждые 500 мс
        }
    }

    sendContinuousData();
}
// =============== ДОБАВЛЕНИЕ ТРЕКОВ ===============

async function addTrackToQueue(trackName) {
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) return false;

    const videoUrl = await searchYouTube(trackName);
    if (!videoUrl) return false;

    // Проверка дубликатов
    if (audioFilesCache.some(t => t.sourceUrl === videoUrl)) {
        console.log('⚠️  Уже в очереди:', videoUrl);
        return false;
    }

    try {
        const filePath = await downloadYouTubeTrack(videoUrl);
        const metadata = await parseFile(filePath);

        // Читаем длительность и битрейт
        const duration = metadata.format.duration 
            ? Math.round(metadata.format.duration * 1000) 
            : 180000; // 3 минуты по умолчанию

        const bitrate = metadata.format.bitrate 
            ? Math.round(metadata.format.bitrate) 
            : 128000; // 128 kbps по умолчанию

        const newTrack = {
            path: filePath,
            duration,
            bitrate, // 🔥 Добавляем битрейт
            name: path.basename(filePath, path.extname(filePath)),
            isDownloaded: true,
            sourceUrl: videoUrl
        };

        // Вставляем после текущего трека
        const insertIndex = (currentTrackIndex + 1) % (audioFilesCache.length + 1);
        audioFilesCache.splice(insertIndex, 0, newTrack);

        console.log(`✅ Трек добавлен в позицию ${insertIndex + 1}: ${newTrack.name}`);
        console.log(`📊 Длительность: ${Math.round(duration / 1000)} сек, Битрейт: ${bitrate / 1000} kbps`);

        // Если поток не запущен — начинаем
        if (!isStreaming && audioFilesCache.length > 0) {
            console.log('▶️ Запускаем поток');
            connectToIcecast();
        }

        return true;
    } catch (error) {
        console.error('❌ Ошибка добавления трека:', error);
        return false;
    }
}

// =============== СЕРВЕР ===============

const server = http.createServer(async (req, res) => {
    if (req.url === '/add' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { track } = JSON.parse(body);
                if (!track) throw new Error('No track');

                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ success: true, message: 'Трек добавлен в очередь' }));

                setTimeout(() => addTrackToQueue(track), 100);
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Invalid request' }));
            }
        });
        return;
    }

    if (req.url === '/add' && req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    if (req.url === '/stream.mp3') {
        res.writeHead(302, { 'Location': `http://${SERVER_IP}:${ICECAST_PORT}/highrise-radio.mp3` });
        res.end();
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <h1>🎧 Highrise Radio</h1>
        <input type="text" id="trackInput" placeholder="Название трека">
        <button onclick="addTrack()">Добавить</button>
        <p id="status"></p>
        <audio controls src="/stream.mp3"></audio>
        <script>
            async function addTrack() {
                const track = document.getElementById('trackInput').value;
                if (!track) return;
                const res = await fetch('/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ track })
                });
                const data = await res.json();
                document.getElementById('status').textContent = data.message;
                document.getElementById('trackInput').value = '';
            }
        </script>
    `);
});

// =============== ЗАПУСК ===============

getAudioFilesWithDurations().then(files => {
    audioFilesCache = files;
    console.log(`✅ Загружено ${files.length} треков`);
    if (files.length > 0) {
        console.log('🚀 Запускаем радио');
        connectToIcecast();
    } else {
        console.log('ℹ️  Папка audio пуста. Добавьте треки через /add');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://${SERVER_IP}:${PORT}
🎧 Поток: http://${SERVER_IP}:${ICECAST_PORT}/highrise-radio.mp3

💡 Убедитесь в icecast.xml:
   - source-password: ${ICECAST_PASSWORD}
   - bind-address: 0.0.0.0
   - port: ${ICECAST_PORT}
   - mount: /highrise-radio.mp3
`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    if (icecastSocket) icecastSocket.destroy();
    process.exit(0);
});