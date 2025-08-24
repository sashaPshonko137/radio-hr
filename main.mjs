import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { Server } from 'socket.io';
import { parseFile } from 'music-metadata';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
const PORT = 8000;
const CACHE_DIR = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`📁 Создана папка кэша: ${CACHE_DIR}`);
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

// Глобальное состояние
let audioFilesCache = [];
let currentTrackIndex = 0;
let trackStartTime = 0;
let isPlaying = false;
let nextTrackTimeout = null;
let io = null;

// Вспомогательные функции
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
            resolve(!!(stdout && stdout.trim()));
        });
    });
}

async function searchYouTube(trackName) {
    try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(trackName)}`;
        const response = await fetch(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
        });
        
        const html = await response.text();
        const regex = /"videoId":"([^"]{11})"/;
        const match = html.match(regex);
        
        return match && match[1] ? `https://www.youtube.com/watch?v=${match[1]}` : null;
    } catch (error) {
        console.error('❌ Ошибка поиска:', error);
        return null;
    }
}

async function downloadYouTubeTrack(videoUrl) {
    try {
        const cacheFileName = await getCacheFileName(videoUrl);
        const cacheFilePath = path.join(CACHE_DIR, cacheFileName);
        
        if (fs.existsSync(cacheFilePath)) {
            return cacheFilePath;
        }
        
        const ytDlpCommand = fs.existsSync(path.join(os.homedir(), 'yt-dlp')) ? 
            path.join(os.homedir(), 'yt-dlp') : 'yt-dlp';
        
        const command = `${ytDlpCommand} -x --audio-format mp3 --audio-quality 0 -o "${cacheFilePath}" "${videoUrl}"`;
        
        return new Promise((resolve, reject) => {
            exec(command, { timeout: 120000 }, (error) => {
                if (error) reject(error);
                else resolve(cacheFilePath);
            });
        });
    } catch (error) {
        throw error;
    }
}

async function scanDirectory(dir, isCached) {
    try {
        if (!fs.existsSync(dir)) return [];
        
        const files = fs.readdirSync(dir)
            .filter(file => ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(path.extname(file).toLowerCase()))
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
    return youtubeMatch && youtubeMatch[1] ? `https://www.youtube.com/watch?v=${youtubeMatch[1]}` : null;
}

// Функции управления состоянием и синхронизацией
function broadcastState() {
    if (!io) return;
    
    const currentTrack = audioFilesCache[currentTrackIndex];
    const progress = currentTrack && isPlaying ? Date.now() - trackStartTime : 0;
    
    io.emit('player_state', {
        isPlaying: isPlaying,
        currentTrack: currentTrack,
        progress: progress,
        queue: audioFilesCache,
        currentIndex: currentTrackIndex
    });
}

function startGlobalTrackTimer() {
    function playNextTrack() {
        if (nextTrackTimeout) {
            clearTimeout(nextTrackTimeout);
            nextTrackTimeout = null;
        }
        
        if (audioFilesCache.length === 0) {
            isPlaying = false;
            broadcastState();
            return;
        }
        
        if (currentTrackIndex < 0 || currentTrackIndex >= audioFilesCache.length) {
            currentTrackIndex = 0;
        }
        
        const track = audioFilesCache[currentTrackIndex];
        if (!track) {
            currentTrackIndex = 0;
            if (audioFilesCache.length > 0) {
                setTimeout(playNextTrack, 1000);
            }
            return;
        }
        
        trackStartTime = Date.now();
        isPlaying = true;
        
        console.log(`\n🌐 Сейчас играет: ${track.name}`);
        broadcastState();
        
        nextTrackTimeout = setTimeout(() => {
            const wasDownloaded = track.isDownloaded;

            if (wasDownloaded) {
                audioFilesCache.splice(currentTrackIndex, 1);
                if (currentTrackIndex >= audioFilesCache.length) {
                    currentTrackIndex = 0;
                }
            } else {
                currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
            }

            if (audioFilesCache.length === 0) {
                isPlaying = false;
                broadcastState();
                return;
            }

            setTimeout(() => {
                playNextTrack();
            }, 3000);

        }, track.duration);
    }

    playNextTrack();
}

async function addTrackToQueue(trackName, socket) {
    try {
        const hasYtDlp = await checkYtDlp();
        if (!hasYtDlp) {
            socket.emit('error', { message: 'yt-dlp не установлен на сервере' });
            return false;
        }

        const videoUrl = await searchYouTube(trackName);
        if (!videoUrl) {
            socket.emit('error', { message: 'Трек не найден на YouTube' });
            return false;
        }
        
        const cacheFileName = await getCacheFileName(videoUrl);
        const cacheFilePath = path.join(CACHE_DIR, cacheFileName);
        
        const isDuplicateInQueue = audioFilesCache.some(track => 
            track.sourceUrl && track.sourceUrl === videoUrl
        );
        
        if (isDuplicateInQueue) {
            socket.emit('error', { message: 'Этот трек уже в очереди' });
            return false;
        }
        
        socket.emit('info', { message: 'Скачивание трека...' });
        const filePath = await downloadYouTubeTrack(videoUrl);
        
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
        
        let insertIndex = audioFilesCache.length === 0 ? 0 : (currentTrackIndex + 1) % (audioFilesCache.length + 1);
        audioFilesCache.splice(insertIndex, 0, newTrack);
        
        socket.emit('info', { message: `Трек добавлен: ${newTrack.name}` });
        broadcastState();
        
        if (audioFilesCache.length === 1) {
            if (nextTrackTimeout) clearTimeout(nextTrackTimeout);
            startGlobalTrackTimer();
        }
        
        return true;
    } catch (error) {
        console.error('❌ Ошибка добавления трека:', error);
        socket.emit('error', { message: 'Ошибка при добавлении трека' });
        return false;
    }
}

// Создаём сервер
const server = http.createServer(async (req, res) => {
    // Обслуживаем аудиопоток
    if (req.url === '/stream.mp3') {
        if (audioFilesCache.length === 0) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Нет аудиофайлов');
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });

        const SKIP_THRESHOLD_MS = 35000;
        const DELAY_IF_PLAYING_MS = 22000;

        let currentTrack = null;
        let nextTrack = null;

        if (isPlaying && trackStartTime > 0 && currentTrackIndex >= 0 && currentTrackIndex < audioFilesCache.length) {
            currentTrack = audioFilesCache[currentTrackIndex];
            const elapsed = Date.now() - trackStartTime;
            const remainingMs = currentTrack.duration - elapsed;

            if (remainingMs < SKIP_THRESHOLD_MS) {
                const nextIndex = (currentTrackIndex + 1) % audioFilesCache.length;
                nextTrack = audioFilesCache[nextIndex];
            } else {
                const startPosition = elapsed + DELAY_IF_PLAYING_MS;
                const safePosition = Math.min(startPosition, currentTrack.duration - 1000);
                sendTrackFromPosition(res, currentTrack, safePosition);
                return;
            }
        } else {
            nextTrack = audioFilesCache[0] || null;
        }

        if (nextTrack) {
            const waitMs = currentTrack ? Math.max(1000, currentTrack.duration - (Date.now() - trackStartTime)) : 1000;
            setTimeout(() => {
                if (!res.finished) {
                    sendTrackFromPosition(res, nextTrack, 0);
                }
            }, waitMs);
            return;
        }

        res.end();
        return;
    }

    // Простой статус для проверки работы сервера
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
        status: 'online', 
        currentTrack: audioFilesCache[currentTrackIndex]?.name || 'None',
        queueLength: audioFilesCache.length 
    }));
});

function sendTrackFromPosition(res, track, positionMs) {
    if (positionMs >= track.duration) positionMs = 0;
    if (!fs.existsSync(track.path)) {
        res.end();
        return;
    }

    const readStream = fs.createReadStream(track.path);
    
    if (positionMs > 0) {
        const bytesToSkip = Math.floor((positionMs / 1000) * 16000);
        let bytesSkipped = 0;
        
        readStream.on('data', (chunk) => {
            if (bytesSkipped < bytesToSkip) {
                bytesSkipped += chunk.length;
                if (bytesSkipped >= bytesToSkip && !res.finished) {
                    const remainingChunk = chunk.slice(bytesToSkip - (bytesSkipped - chunk.length));
                    res.write(remainingChunk);
                }
            } else if (!res.finished) {
                res.write(chunk);
            }
        });
    } else {
        readStream.pipe(res, { end: false });
    }

    readStream.on('end', () => {
        if (!res.finished) res.end();
    });

    readStream.on('error', () => {
        if (!res.finished) res.end();
    });
}

// Инициализация Socket.IO
io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Обработка WebSocket соединений
io.on('connection', (socket) => {
    console.log('🔗 Новое WebSocket подключение');
    
    // Отправляем текущее состояние новому клиенту
    socket.emit('player_state', {
        isPlaying: isPlaying,
        currentTrack: audioFilesCache[currentTrackIndex],
        progress: isPlaying ? Date.now() - trackStartTime : 0,
        queue: audioFilesCache,
        currentIndex: currentTrackIndex
    });

    // Обработка добавления трека
    socket.on('add_track', async (data) => {
        if (!data.track) {
            socket.emit('error', { message: 'Не указано название трека' });
            return;
        }
        await addTrackToQueue(data.track, socket);
    });

    // Обработка запроса пропуска трека
    socket.on('skip_track', () => {
        if (audioFilesCache.length === 0) return;
        
        if (nextTrackTimeout) {
            clearTimeout(nextTrackTimeout);
            nextTrackTimeout = null;
        }
        
        const wasDownloaded = audioFilesCache[currentTrackIndex]?.isDownloaded;
        if (wasDownloaded) {
            audioFilesCache.splice(currentTrackIndex, 1);
            if (currentTrackIndex >= audioFilesCache.length) {
                currentTrackIndex = 0;
            }
        } else {
            currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
        }
        
        if (audioFilesCache.length > 0) {
            setTimeout(() => startGlobalTrackTimer(), 1000);
        } else {
            isPlaying = false;
            broadcastState();
        }
    });

    socket.on('disconnect', () => {
        console.log('🔗 WebSocket отключение');
    });
});

// Инициализация сервера
async function initializeServer() {
    try {
        // Загружаем статические треки
        audioFilesCache = await scanDirectory(AUDIO_DIR, false);
        console.log(`✅ Загружено ${audioFilesCache.length} треков`);
        
        // Запускаем таймер воспроизведения
        startGlobalTrackTimer();
        
        // Запускаем сервер
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Аудиопоток: http://${SERVER_IP}:${PORT}/stream.mp3
🔗 WebSocket: ws://${SERVER_IP}:${PORT}

📁 Аудиофайлы из папки: ${AUDIO_DIR}
🌐 Сервер доступен по IP: ${SERVER_IP}
`);
        });
    } catch (err) {
        console.error('❌ Ошибка инициализации сервера:', err);
        process.exit(1);
    }
}

// Обработка graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Выключаем сервер...');
    if (nextTrackTimeout) clearTimeout(nextTrackTimeout);
    server.close(() => process.exit(0));
});

// Запуск
initializeServer();