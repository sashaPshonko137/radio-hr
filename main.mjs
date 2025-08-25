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
const AZURACAST_URL = 'http://localhost'; // URL вашего AzuraCast
const AZURACAST_API_KEY = 'ваш_api_ключ'; // Замените на ваш API ключ
const STATION_ID = '1'; // ID вашей радиостанции (обычно 1)

// Убедитесь, что папки существуют
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
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
        exec('which yt-dlp', (error) => {
            resolve(!error);
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

    const ytDlpCommand = fs.existsSync(`${os.homedir()}/yt-dlp`) ? 
        `${os.homedir()}/yt-dlp` : 'yt-dlp';
    
    const command = `${ytDlpCommand} -x --audio-format mp3 --audio-quality 0 -o "${cacheFilePath}" "${videoUrl}"`;
    
    return new Promise((resolve, reject) => {
        exec(command, { timeout: 120000 }, (error) => {
            error ? reject(error) : resolve(cacheFilePath);
        });
    });
}

// Добавить трек в AzuraCast как следующий
async function addToAzuraCast(filePath, trackName) {
    try {
        // Сначала загружаем файл
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));
        
        const uploadResponse = await fetch(
            `${AZURACAST_URL}/api/station/${STATION_ID}/files`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${AZURACAST_API_KEY}`,
                    'Content-Type': 'multipart/form-data'
                },
                body: formData
            }
        );
        
        if (!uploadResponse.ok) {
            throw new Error(`Ошибка загрузки: ${uploadResponse.status}`);
        }
        
        // Получаем ID файла
        const fileData = await uploadResponse.json();
        const fileId = fileData.id;
        
        // Добавляем в плейлист "Следующий трек"
        const playlistResponse = await fetch(
            `${AZURACAST_URL}/api/station/${STATION_ID}/playlist/2/queue`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${AZURACAST_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    id: fileId,
                    time: 0
                })
            }
        );
        
        if (!playlistResponse.ok) {
            throw new Error(`Ошибка добавления в плейлист: ${playlistResponse.status}`);
        }
        
        console.log(`✅ Трек добавлен в AzuraCast: ${trackName}`);
        return true;
    } catch (error) {
        console.error('❌ Ошибка добавления в AzuraCast:', error);
        return false;
    }
}

// =============== ДОБАВЛЕНИЕ ТРЕКОВ ===============

async function addTrackToQueue(trackName) {
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) return false;

    const videoUrl = await searchYouTube(trackName);
    if (!videoUrl) return false;

    try {
        const filePath = await downloadYouTubeTrack(videoUrl);
        const name = path.basename(filePath, path.extname(filePath));
        
        console.log(`✅ Трек добавлен: ${name}`);
        
        // Добавляем в AzuraCast как следующий трек
        await addToAzuraCast(filePath, name);
        
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
        res.writeHead(302, { 'Location': `http://${SERVER_IP}:8000/radio.mp3` });
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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://${SERVER_IP}:${PORT}
🎧 Поток: http://${SERVER_IP}:8000/radio.mp3

💡 Для работы:
1. Установите AzuraCast через Docker
2. Настройте радиостанцию в веб-интерфейсе
3. Получите API ключ в Настройках → API Токены
4. Замените AZURACAST_API_KEY в коде
5. Добавляйте треки через веб-интерфейс
`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    process.exit(0);
});