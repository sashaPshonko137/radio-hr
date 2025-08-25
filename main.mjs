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
const VLC_HTTP_PORT = 8080;
const VLC_PASSWORD = 'hackme';

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

// Проверка подключения к VLC
function checkVLCConnection() {
    return new Promise((resolve) => {
        console.log('📡 Проверка подключения к VLC...');
        const url = `http://localhost:${VLC_HTTP_PORT}/requests/status.json`;
        
        const options = {
            auth: `:${VLC_PASSWORD}`
        };
        
        http.get(url, options, (res) => {
            if (res.statusCode === 200) {
                console.log('🟢 VLC подключён успешно');
                resolve(true);
            } else {
                console.error('🔴 VLC недоступен:', res.statusCode);
                resolve(false);
            }
        }).on('error', (err) => {
            console.error('🔴 VLC недоступен:', err.message);
            resolve(false);
        });
    });
}

// Добавить трек в очередь VLC
function addToVLC(filePath, insertNext = false) {
    return new Promise((resolve, reject) => {
        const url = `http://localhost:${VLC_HTTP_PORT}/requests/status.json`;
        const options = {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`:${VLC_PASSWORD}`).toString('base64')
            }
        };
        
        let command;
        if (insertNext) {
            command = `command=pl_add&input=${encodeURIComponent(filePath)}&option=start&name=${path.basename(filePath)}`;
        } else {
            command = `command=pl_add&input=${encodeURIComponent(filePath)}&name=${path.basename(filePath)}`;
        }
        
        const req = http.request(url + '?' + command, options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`✅ Трек добавлен в VLC: ${filePath}`);
                    resolve(data);
                } else {
                    console.error('❌ Ошибка VLC:', data);
                    reject(new Error(`VLC error: ${res.statusCode}`));
                }
            });
        });
        
        req.on('error', (error) => {
            console.error('❌ Ошибка запроса к VLC:', error);
            reject(error);
        });
        
        req.end();
    });
}

// =============== ДОБАВЛЕНИЕ ТРЕКОВ ===============

async function addTrackToQueue(trackName) {
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) return false;

    const videoUrl = await searchYouTube(trackName);
    if (!videoUrl) return false;

    // Проверяем, есть ли уже такой трек в кэше
    const cacheFileName = await getCacheFileName(videoUrl);
    const cacheFilePath = path.join(CACHE_DIR, cacheFileName);
    
    if (fs.existsSync(cacheFilePath)) {
        console.log(`✅ Используем кэшированный трек: ${cacheFilePath}`);
        
        // Добавляем в VLC как следующий трек
        await addToVLC(cacheFilePath, true);
        return true;
    }

    try {
        const filePath = await downloadYouTubeTrack(videoUrl);
        const name = path.basename(filePath, path.extname(filePath));
        
        console.log(`✅ Трек добавлен: ${name}`);
        
        // Добавляем в VLC как следующий трек
        await addToVLC(filePath, true);
        
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
        res.writeHead(302, { 'Location': `http://${SERVER_IP}:8000/` });
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

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`
🚀 Сервер запущен: http://${SERVER_IP}:${PORT}
🎧 Поток: http://${SERVER_IP}:8000/

💡 Для работы:
1. Установите VLC: sudo apt install vlc
2. Запустите VLC сервер:
   cvlc --intf http --http-port 8080 --http-password "hackme" \\
     --sout "#transcode{acodec=mp3,ab=128}:http{mux=mp3,dst=:8000/}" \\
     --loop /путь/к/вашей/audio-папке
3. Добавляйте треки через веб-интерфейс
`);
    
    // Проверяем подключение к VLC
    const isConnected = await checkVLCConnection();
    
    if (isConnected) {
        console.log('✅ VLC работает корректно');
    } else {
        console.log('⚠️  VLC не подключен. Некоторые функции будут недоступны.');
    }
});

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    process.exit(0);
});