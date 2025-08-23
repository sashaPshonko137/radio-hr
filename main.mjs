import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { parseFile } from 'music-metadata';

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

// Альтернативный способ поиска через YouTube API
async function searchYouTube(trackName) {
    try {
        console.log(`🔍 Ищем трек: "${trackName}"`);
        
        // Используем простой поиск через регулярки
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(trackName)}`;
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const html = await response.text();
        
        // Ищем videoId в HTML
        const regex = /"videoId":"([^"]{11})"/g;
        const matches = [];
        let match;
        
        while ((match = regex.exec(html)) !== null) {
            matches.push(match[1]);
        }
        
        // Убираем дубликаты
        const uniqueMatches = [...new Set(matches)];
        
        if (uniqueMatches.length === 0) {
            console.log('❌ Трек не найден');
            return null;
        }
        
        const videoId = uniqueMatches[0];
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        console.log(`📥 Найден видео: ${videoUrl}`);
        return videoUrl;
        
    } catch (error) {
        console.error('❌ Ошибка поиска:', error);
        return null;
    }
}

// Функция для получения прямых ссылок на аудио
async function getAudioStreamUrl(videoUrl) {
    try {
        // Временное решение: возвращаем URL для прямого потока
        // На практике нужно использовать библиотеку для извлечения ссылок
        const response = await fetch(videoUrl);
        const html = await response.text();
        
        // Попробуем найти ссылку на аудио в HTML
        const regex = /(https?:\/\/[^"]*\.googlevideo\.com[^"]*audio[^"]*)/;
        const match = html.match(regex);
        
        if (match) {
            return match[1];
        }
        
        // Если не нашли, вернем оригинальный URL (для демонстрации)
        return videoUrl;
        
    } catch (error) {
        console.error('❌ Ошибка получения аудио:', error);
        return null;
    }
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
async function addTrackToQueue(trackName) {
    console.log(`🎵 Добавляем в очередь: "${trackName}"`);
    
    // Временно: просто добавляем заглушку
    // В реальном приложении здесь должна быть логика скачивания
    const newTrack = {
        path: path.join(AUDIO_DIR, 'example.mp3'), // Заглушка
        duration: 180000, // 3 минуты
        name: trackName
    };
    
    // Добавляем трек СРАЗУ ПОСЛЕ ТЕКУЩЕГО
    const insertIndex = currentTrackIndex + 1;
    audioFilesCache.splice(insertIndex, 0, newTrack);
    
    console.log(`✅ Трек добавлен в позицию ${insertIndex + 1}: ${trackName}`);
    console.log(`⏱️  Будет воспроизведен после текущего трека`);
    
    return true;
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

    // Проверяем существует ли файл
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

    readStream.on('error', (err) => {
        console.error('❌ Ошибка отправки трека:', err);
        if (!res.finished) {
            res.end();
        }
    });
}

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
                const success = await addTrackToQueue(track);
                
                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });
                
                res.end(JSON.stringify({ 
                    success, 
                    message: success ? 'Трек добавлен в очередь после текущего' : 'Ошибка добавления трека' 
                }));
                
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

⚠️  Функция скачивания временно отключена из-за проблем с YouTube API
`);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Выключаем сервер...');
    activeConnections.forEach(res => {
        if (!res.finished) res.end();
    });
    process.exit(0);
});