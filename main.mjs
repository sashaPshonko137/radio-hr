import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { parseFile } from 'music-metadata';
import { exec } from 'child_process';
import icecast from 'icecast-client'; // Импортируем библиотеку

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
const PORT = 8008;
const ICECAST_PORT = 8000;
const CACHE_DIR = path.join(__dirname, 'cache');
const ICECAST_PASSWORD = 'hackme';

let icecastStream = null; // Теперь это будет поток от icecast-client
let isStreaming = false;
let audioFilesCache = [];

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

// =============== ПОДКЛЮЧЕНИЕ К ICECAST ЧЕРЕЗ БИБЛИОТЕКУ ===============

async function connectToIcecast() {
    try {
        // Уничтожаем предыдущее соединение, если оно есть
        if (icecastStream) {
            icecastStream.end();
            icecastStream = null;
        }

        console.log(`📡 Подключаемся к Icecast: localhost:${ICECAST_PORT}`);
        
        // Создаем поток к Icecast с помощью библиотеки
        icecastStream = await icecast.write(`http://localhost:${ICECAST_PORT}/highrise-radio.mp3`, {
            auth: {
                username: 'source',  // Всегда 'source' для подключения
                password: ICECAST_PASSWORD
            },
            headers: {
                'Content-Type': 'audio/mpeg',
                'icy-name': 'Highrise Radio',
                'icy-genre': 'Virtual',
                'icy-pub': 1
            }
        });

        console.log('🎉 Успешное подключение к Icecast');

        // Обрабатываем ошибки
        icecastStream.on('error', (err) => {
            console.error('❌ Ошибка Icecast:', err.message);
            setTimeout(connectToIcecast, 5000);
        });

        // Запускаем поток, если есть треки
        if (audioFilesCache.length > 0) {
            isStreaming = true;
            playNextTrack();
        }

        return true;
    } catch (err) {
        console.error('❌ Не удалось подключиться к Icecast:', err.message);
        setTimeout(connectToIcecast, 5000);
        return false;
    }
}

// =============== ПОТОК С ИСПОЛЬЗОВАНИЕМ БИБЛИОТЕКИ ===============

function playNextTrack() {
    if (!isStreaming || audioFilesCache.length === 0) {
        console.log('⏸️  Очередь пуста');
        return;
    }

    const track = audioFilesCache[0];
    console.log(`🎵 Начинаем трек: ${track.name}`);

    // Создаем поток чтения
    const readStream = fs.createReadStream(track.path);

    // Отправляем в Icecast
    readStream.pipe(icecastStream, { end: false });

    readStream.on('error', (err) => {
        console.error(`❌ Ошибка чтения ${track.name}:`, err.message);
        audioFilesCache.shift(); // Удаляем проблемный трек
        playNextTrack(); // Следующий трек
    });

    readStream.on('end', () => {
        console.log(`⏹️  Трек завершён: ${track.name}`);

        // Удаляем временный трек
        if (track.isDownloaded) {
            try {
                fs.unlinkSync(track.path);
                console.log(`🗑️  Удалён: ${track.name}`);
            } catch (err) {
                console.error('❌ Не удалось удалить:', err);
            }
        }

        // Удаляем из очереди
        audioFilesCache.shift();

        // Следующий трек
        playNextTrack();
    });
}

// =============== ДОБАВЛЕНИЕ ТРЕКОВ ===============

async function addTrackToQueue(trackName) {
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) return false;

    const videoUrl = await searchYouTube(trackName);
    if (!videoUrl) return false;

    if (audioFilesCache.some(t => t.sourceUrl === videoUrl)) {
        console.log('⚠️  Уже в очереди:', videoUrl);
        return false;
    }

    try {
        const filePath = await downloadYouTubeTrack(videoUrl);
        const metadata = await parseFile(filePath);
        const bitrate = metadata.format.bitrate || 128000;

        const newTrack = {
            path: filePath,
            bitrate,
            name: path.basename(filePath, path.extname(filePath)),
            isDownloaded: true,
            sourceUrl: videoUrl
        };

        // Вставляем после текущего трека (после первого элемента)
        if (audioFilesCache.length > 0) {
            audioFilesCache.splice(1, 0, newTrack);
        } else {
            audioFilesCache.push(newTrack);
        }

        console.log(`✅ Трек добавлен: ${newTrack.name}`);

        // Если поток не запущен — начинаем
        if (!isStreaming && audioFilesCache.length > 0) {
            console.log('▶️ Запускаем поток');
            connectToIcecast();
        }

        return true;
    } catch (error) {
        console.error('❌ Ошибка добавления:', error);
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
    if (icecastStream) {
        icecastStream.end();
    }
    process.exit(0);
});