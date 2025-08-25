import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { parseFile } from 'music-metadata';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
const PORT = 8008;
const CACHE_DIR = path.join(__dirname, 'cache');
const PLAYLIST_FILE = path.join(__dirname, 'playlist.txt');
const ICECAST_PASSWORD = 'hackme';

// Создаем папку кэша
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

// Обновляем плейлист
function updatePlaylist() {
    try {
        // Собираем все MP3 файлы из AUDIO_DIR и CACHE_DIR
        const audioFiles = fs.readdirSync(AUDIO_DIR)
            .filter(file => path.extname(file).toLowerCase() === '.mp3')
            .map(file => {
                // Преобразуем путь в формат, который понимает Liquidsoap
                return path.resolve(AUDIO_DIR, file);
            })
            .join('\n');
            
        const cacheFiles = fs.readdirSync(CACHE_DIR)
            .filter(file => path.extname(file).toLowerCase() === '.mp3')
            .map(file => {
                // Преобразуем путь в формат, который понимает Liquidsoap
                return path.resolve(CACHE_DIR, file);
            })
            .join('\n');
            
        // Записываем в playlist.txt
        fs.writeFileSync(PLAYLIST_FILE, `${audioFiles}\n${cacheFiles}`);
        console.log('✅ Плейлист обновлен');
    } catch (err) {
        console.error('❌ Не удалось обновить плейлист:', err);
    }
}

// Меняем следующий трек через Liquidsoap API
async function changeNextTrack(filePath) {
    try {
        const response = await fetch(`http://localhost:1234/radio/next?uri=${encodeURIComponent(filePath)}`);
        const result = await response.text();
        console.log(`✅ ${result}`);
        return true;
    } catch (error) {
        console.error('❌ Не удалось изменить трек:', error);
        return false;
    }
}

// Проверяем, запущен ли Liquidsoap
function isLiquidsoapRunning() {
    try {
        // Проверяем, доступен ли API Liquidsoap
        exec('docker inspect -f \'{{.State.Running}}\' highrise-radio', (error, stdout) => {
            return stdout.trim() === 'true';
        });
        return true;
    } catch (err) {
        return false;
    }
}

// =============== ДОБАВЛЕНИЕ ТРЕКОВ ===============

async function addTrackToQueue(trackName) {
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) return false;

    const videoUrl = await searchYouTube(trackName);
    if (!videoUrl) return false;

    // Проверяем, не в очереди ли уже этот трек
    const cacheFileName = await getCacheFileName(videoUrl);
    const cacheFilePath = path.join(CACHE_DIR, cacheFileName);
    
    if (fs.existsSync(cacheFilePath)) {
        console.log('⚠️  Уже в очереди:', videoUrl);
        return false;
    }

    try {
        const filePath = await downloadYouTubeTrack(videoUrl);
        const metadata = await parseFile(filePath);
        const name = path.basename(filePath, path.extname(filePath));
        
        console.log(`✅ Трек добавлен: ${name}`);
        updatePlaylist(); // Обновляем плейлист для Liquidsoap
        
        // Если поток запущен, меняем следующий трек
        if (isLiquidsoapRunning()) {
            await changeNextTrack(filePath);
        } else {
            console.log('ℹ️  Liquidsoap не запущен. Запустите контейнер.');
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
        res.writeHead(302, { 'Location': `http://${SERVER_IP}:8000/highrise-radio.mp3` });
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

// Инициализируем плейлист
updatePlaylist();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://${SERVER_IP}:${PORT}
🎧 Поток: http://${SERVER_IP}:8000/highrise-radio.mp3

💡 Для работы радио:
1. Убедитесь, что Docker установлен
2. Запустите контейнер Liquidsoap:
   docker run -d --name highrise-radio -p 8000:8000 -p 1234:1234 \\
     -v "$(pwd)/playlist.txt:/app/playlist.txt" \\
     -v "$(pwd)/radio.liq:/app/radio.liq" \\
     -v "$(pwd):/media" \\
     savonet/liquidsoap:latest /app/radio.liq
3. Убедитесь в icecast.xml:
   - source-password: ${ICECAST_PASSWORD}
   - bind-address: 0.0.0.0
   - port: 8000
   - mount: /highrise-radio.mp3
`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    process.exit(0);
});