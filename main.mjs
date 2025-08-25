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
const MPD_PORT = 6600; // Порт для MPD

// Убедитесь, что папки существуют
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
    
    if (fs.existsSync(cacheFilePath)) {
        console.log(`✅ Используем кэшированный трек: ${cacheFilePath}`);
        return cacheFilePath;
    }

    console.log(`📥 Скачиваем: ${videoUrl}`);
    
    const ytDlpCommand = fs.existsSync(`${os.homedir()}/yt-dlp`) ? 
        `${os.homedir()}/yt-dlp` : 'yt-dlp';
    
    const command = `${ytDlpCommand} -x --audio-format mp3 --audio-quality 0 -o "${cacheFilePath}" "${videoUrl}"`;
    
    return new Promise((resolve, reject) => {
        exec(command, { timeout: 120000 }, (error) => {
            if (error) {
                console.error('❌ Ошибка скачивания:', error);
                reject(error);
            } else {
                console.log(`✅ Трек сохранен: ${cacheFilePath}`);
                resolve(cacheFilePath);
            }
        });
    });
}

// Проверка подключения к MPD
function checkMPDConnection() {
    return new Promise((resolve) => {
        console.log('📡 Проверка подключения к MPD...');
        exec(`mpc -p ${MPD_PORT} status`, (error, stdout, stderr) => {
            if (error) {
                console.error('🔴 MPD недоступен:', stderr.trim() || error.message);
                console.log(`💡 Убедитесь, что MPD запущен: mpd /etc/mpd.conf`);
                resolve(false);
            } else {
                console.log('🟢 MPD подключён успешно');
                console.log(`📋 Статус MPD:\n${stdout}`);
                resolve(true);
            }
        });
    });
}

// Добавить трек в MPD
function addToMPD(filePath, insertNext = false) {
    return new Promise((resolve, reject) => {
        const cmd = insertNext 
            ? `mpc -p ${MPD_PORT} addid "${filePath}" 0` 
            : `mpc -p ${MPD_PORT} add "${filePath}"`;
        
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Ошибка MPD:', stderr);
                reject(error);
            } else {
                console.log(`✅ Трек добавлен в MPD: ${filePath}`);
                resolve(stdout);
            }
        });
    });
}

// Проверить, есть ли уже такой трек в очереди
function isTrackInQueue(videoUrl) {
    return new Promise((resolve) => {
        const cmd = `mpc -p ${MPD_PORT} playlist`;
        
        exec(cmd, (error, stdout) => {
            if (error) {
                console.error('❌ Ошибка проверки очереди:', error);
                resolve(false);
                return;
            }
            
            const playlist = stdout.split('\n').filter(Boolean);
            const cacheFileName = getCacheFileName(videoUrl);
            
            const isDuplicate = playlist.some(track => {
                const trackPath = path.basename(track);
                return trackPath === cacheFileName;
            });
            
            resolve(isDuplicate);
        });
    });
}

// Получить список треков из MPD
async function getMPDPlaylist() {
    return new Promise((resolve) => {
        const cmd = `mpc -p ${MPD_PORT} playlist`;
        
        exec(cmd, (error, stdout) => {
            if (error) {
                console.error('❌ Ошибка получения плейлиста:', error);
                resolve([]);
                return;
            }
            
            const tracks = stdout.split('\n')
                .filter(track => track.trim() !== '')
                .map(track => ({
                    path: track,
                    name: path.basename(track, path.extname(track)),
                    isDownloaded: track.includes('cache')
                }));
            
            resolve(tracks);
        });
    });
}

// =============== ДОБАВЛЕНИЕ ТРЕКОВ ===============

async function addTrackToQueue(trackName) {
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) {
        console.error('❌ yt-dlp не установлен');
        return false;
    }

    const videoUrl = await searchYouTube(trackName);
    if (!videoUrl) {
        console.error('❌ Трек не найден');
        return false;
    }

    // Проверяем, есть ли уже такой трек в очереди
    const isDuplicate = await isTrackInQueue(videoUrl);
    if (isDuplicate) {
        console.log('⚠️  Трек уже в очереди:', videoUrl);
        return false;
    }

    try {
        const filePath = await downloadYouTubeTrack(videoUrl);
        const name = path.basename(filePath, path.extname(filePath));
        
        console.log(`✅ Трек добавлен: ${name}`);
        
        // Добавляем в MPD как следующий трек
        await addToMPD(filePath, true);
        
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
        res.writeHead(302, { 'Location': `http://${SERVER_IP}:8000` });
        res.end();
        return;
    }

    if (req.url === '/status') {
        try {
            const playlist = await getMPDPlaylist();
            const cmd = `mpc -p ${MPD_PORT} status`;
            
            exec(cmd, (error, stdout) => {
                if (error) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'MPD недоступен' }));
                    return;
                }
                
                // Парсим статус MPD
                const statusLines = stdout.split('\n');
                const status = {};
                
                for (const line of statusLines) {
                    const [key, value] = line.split(':').map(s => s.trim());
                    if (key && value) {
                        status[key.toLowerCase()] = value;
                    }
                }
                
                // Получаем текущий трек
                let currentTrack = null;
                if (status['volume'] && playlist.length > 0) {
                    const currentPos = status['playing'] ? 
                        parseInt(status['playing'].split('/')[0]) : 0;
                    currentTrack = playlist[currentPos];
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    currentTrack,
                    queue: playlist,
                    mpdStatus: status
                }));
            });
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
        <h1>🎧 Highrise Radio</h1>
        <input type="text" id="trackInput" placeholder="Название трека">
        <button onclick="addTrack()">Добавить</button>
        <p id="status"></p>
        <audio controls src="/stream.mp3"></audio>
        <div style="margin-top: 20px; border-top: 1px solid #ccc; padding-top: 10px;">
            <h2>Текущая очередь</h2>
            <div id="queue"></div>
            <button onclick="refreshQueue()">Обновить</button>
        </div>
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
                refreshQueue();
            }
            
            async function refreshQueue() {
                const res = await fetch('/status');
                const data = await res.json();
                
                if (data.error) {
                    document.getElementById('queue').innerHTML = '<p>Ошибка: ' + data.error + '</p>';
                    return;
                }
                
                let html = '';
                if (data.currentTrack) {
                    html += '<div style="background: #e6f7ff; padding: 10px; margin-bottom: 10px;">';
                    html += '<strong>Сейчас играет:</strong> ' + data.currentTrack.name + '<br>';
                    html += '<small>' + data.currentTrack.path + '</small>';
                    html += '</div>';
                }
                
                html += '<strong>Очередь:</strong><ol>';
                data.queue.forEach((track, index) => {
                    html += '<li>' + track.name + (track.isDownloaded ? ' (YouTube)' : '') + '</li>';
                });
                html += '</ol>';
                
                document.getElementById('queue').innerHTML = html;
            }
            
            // Автоматическое обновление очереди каждые 5 секунд
            setInterval(refreshQueue, 5000);
            refreshQueue();
        </script>
    `);
});

// =============== ЗАПУСК ===============

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`
🚀 Сервер запущен: http://${SERVER_IP}:${PORT}
🎧 Поток: http://${SERVER_IP}:8000

💡 Для работы:
1. Установите MPD: sudo apt install mpd mpc
2. Настройте /etc/mpd.conf
3. Запустите: mpd /etc/mpd.conf
4. Добавляйте треки через веб-интерфейс
`);
    
    // Проверяем подключение к MPD при старте
    const isConnected = await checkMPDConnection();
    
    if (isConnected) {
        console.log('✅ MPD работает корректно');
        
        // Загружаем текущую очередь
        const playlist = await getMPDPlaylist();
        console.log(`📋 Текущая очередь: ${playlist.length} треков`);
        playlist.forEach((track, i) => {
            console.log(`${i + 1}. ${track.name}`);
        });
    } else {
        console.log('⚠️  MPD не подключен. Некоторые функции будут недоступны.');
    }
});

process.on('SIGINT', () => {
    console.log('\n🛑 Остановка сервера...');
    process.exit(0);
});