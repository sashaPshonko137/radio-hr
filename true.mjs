import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { setMaxListeners } from 'events';
import { parseFile } from 'music-metadata';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
const PORT = 8000;
const CACHE_DIR = path.join(__dirname, 'cache');

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
        
        const command = `${ytDlpCommand} -x --audio-format mp3 --audio-quality 0 --postprocessor-args "-b:a 192k -ar 44100" -o "${cacheFilePath}" "${videoUrl}"`;
        
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
                let durationMs;
                let bitrate = metadata.format.bitrate || 128000; // 128 kbps по умолчанию
                
                if (metadata.format.duration) {
                    durationMs = Math.round(metadata.format.duration * 1000);
                } else {
                    const stats = fs.statSync(filePath);
                    durationMs = (stats.size * 8 / bitrate) * 1000;
                    console.log(`⚠️ Для ${path.basename(filePath)} рассчитана длительность: ${Math.round(durationMs/1000)}с`);
                }
                
                filesWithDurations.push({
                    path: filePath,
                    duration: durationMs,
                    bitrate: bitrate,
                    name: path.basename(filePath, path.extname(filePath)),
                    isDownloaded: isCached,
                    sourceUrl: isCached ? extractUrlFromCacheName(filePath) : null
                });
                
            } catch (error) {
                console.error(`❌ Ошибка чтения метаданных ${filePath}:`, error);
                
                try {
                    const stats = fs.statSync(filePath);
                    const bitrate = 128000;
                    const durationMs = (stats.size * 8 / bitrate) * 1000;
                    console.log(`⚠️ Для ${path.basename(filePath)} использована расчетная длительность: ${Math.round(durationMs/1000)}с`);
                    
                    filesWithDurations.push({
                        path: filePath,
                        duration: durationMs,
                        bitrate: bitrate,
                        name: path.basename(filePath, path.extname(filePath)),
                        isDownloaded: isCached,
                        sourceUrl: isCached ? extractUrlFromCacheName(filePath) : null
                    });
                } catch (statError) {
                    console.error('❌ Ошибка получения размера файла:', statError);
                    filesWithDurations.push({
                        path: filePath,
                        duration: 180000,
                        bitrate: 128000,
                        name: path.basename(filePath, path.extname(filePath)),
                        isDownloaded: isCached,
                        sourceUrl: isCached ? extractUrlFromCacheName(filePath) : null
                    });
                }
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

async function getAudioFilesWithDurations() {
    try {
        const audioFiles = await scanDirectory(AUDIO_DIR, false);
        return audioFiles;
    } catch (err) {
        console.error('Ошибка чтения папок с аудио:', err);
        return [];
    }
}

let audioFilesCache = [];
let currentTrackIndex = 0;
let trackStartTime = 0;
let activeConnections = new Set();
let nextTrackTimeout = null;
let isPlaying = false;
let currentPlaybackPosition = 0;
let playbackInterval = null;

let playNextTrackFunction = null;

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
        
        const cacheFileName = await getCacheFileName(videoUrl);
        const cacheFilePath = path.join(CACHE_DIR, cacheFileName);
        
        const isDuplicateInQueue = audioFilesCache.some(track => 
            track.sourceUrl && track.sourceUrl === videoUrl
        );
        
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
        
        let durationMs = 180000;
        let bitrate = 128000;
        try {
            const metadata = await parseFile(filePath);
            durationMs = metadata.format.duration ? Math.round(metadata.format.duration * 1000) : 180000;
            bitrate = metadata.format.bitrate || 128000;
        } catch (error) {
            console.error('❌ Ошибка чтения длительности:', error);
        }
        
        const newTrack = {
            path: filePath,
            duration: durationMs,
            bitrate: bitrate,
            name: path.basename(filePath, path.extname(filePath)),
            isDownloaded: true,
            sourceUrl: videoUrl
        };
        
        // 🔑 КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: вставляем после текущего трека
let boundaryIndex = 0;
for (let i = 0; i < audioFilesCache.length; i++) {
    if (audioFilesCache[i].isDownloaded) {
        boundaryIndex = i;
        break;
    }
}
// Если нет добавленных треков, граница = длине массива
if (boundaryIndex === 0 && !audioFilesCache[0]?.isDownloaded) {
    boundaryIndex = audioFilesCache.length;
}

// ВСТАВЛЯЕМ ПОСЛЕ ГРАНИЦЫ
let insertIndex = boundaryIndex;
        
        audioFilesCache.splice(insertIndex, 0, newTrack);
        
        // 🔑 ВОЗВРАЩАЕМ ПОЗИЦИЮ ТРЕКА (начиная с 1)
        const trackPosition = insertIndex + 1;
        
        console.log(`✅ Трек добавлен в позицию ${trackPosition}: ${newTrack.name}`);
        console.log(`🔗 Источник: ${videoUrl}`);
        console.log(`📊 Трек начнёт воспроизводиться через ${audioFilesCache.length - trackPosition} треков`);
        
        if (audioFilesCache.length === 1 && playNextTrackFunction) {
            console.log('▶️ Немедленный запуск первого трека');
            if (nextTrackTimeout) {
                clearTimeout(nextTrackTimeout);
                nextTrackTimeout = null;
            }
            playNextTrackFunction();
        }
        
        return {
            success: true,
            position: trackPosition,
            tracksUntilPlayback: audioFilesCache.length - trackPosition
        };
        
    } catch (error) {
        console.error('❌ Ошибка добавления трека:', error);
        return { success: false, error: error.message };
    }
}


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

function startGlobalTrackTimer() {
    function playNextTrack() {
        if (nextTrackTimeout) {
            clearTimeout(nextTrackTimeout);
            nextTrackTimeout = null;
        }
        
        if (audioFilesCache.length === 0) {
            console.log('⏸️  Очередь пуста, ждем треки...');
            isPlaying = false;
            return;
        }
        
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
        
        currentPlaybackPosition = 0;
        trackStartTime = Date.now();
        isPlaying = true;
        
        console.log(`\n🌐 Сейчас играет: ${track.name} (${Math.round(track.duration / 1000)} сек)`);
        console.log(`📊 В очереди: ${audioFilesCache.length} треков`);
        
        activeConnections.forEach(res => {
            if (!res.finished) {
                const safePosition = Math.min(currentPlaybackPosition, track.duration - 100);
                sendTrackFromPosition(res, track, safePosition);
            }
        });

        if (playbackInterval) {
            clearInterval(playbackInterval);
        }
        
        playbackInterval = setInterval(() => {
            if (isPlaying && trackStartTime > 0) {
                currentPlaybackPosition = Date.now() - trackStartTime;
            }
        }, 50);

        nextTrackTimeout = setTimeout(() => {
            if (nextTrackTimeout) {
                clearTimeout(nextTrackTimeout);
                nextTrackTimeout = null;
            }
            
            if (audioFilesCache.length === 0) {
                console.log('⏸️  Очередь пуста, ждем треки...');
                isPlaying = false;
                return;
            }
            
            const track = audioFilesCache[currentTrackIndex];
            if (!track) {
                console.error('❌ Трек не найден при завершении');
                if (audioFilesCache.length > 0) {
                    playNextTrack();
                }
                return;
            }
            
            if (track.isDownloaded) {
                console.log(`🗑️  Удаляем временный трек после воспроизведения: ${track.name}`);
                audioFilesCache.splice(currentTrackIndex, 1);
                
                if (currentTrackIndex >= audioFilesCache.length) {
                    currentTrackIndex = 0;
                }
            } else {
                currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
            }
            
            if (audioFilesCache.length === 0) {
                console.log('⏸️  Очередь пуста после удаления');
                isPlaying = false;
                return;
            }
            
            playNextTrack();
        }, track.duration);
    }

    playNextTrackFunction = playNextTrack;
    
    console.log(`\n🚀 Начинаем воспроизведение`);
    playNextTrack();
}

// ИЗМЕНЕННАЯ ФУНКЦИЯ С ТОЛЬКО 5-СЕКУНДНОЙ ТИШИНОЙ
function sendTrackFromPosition(res, track, positionMs) {
    positionMs = Math.max(0, Math.min(positionMs, track.duration - 100));
    
    if (!fs.existsSync(track.path)) {
        console.error(`❌ Файл не существует: ${track.path}`);
        if (!res.finished) {
            res.end();
        }
        return;
    }

    const readStream = fs.createReadStream(track.path);
    
    if (positionMs > 0) {
        const bitrateKbps = track.bitrate / 1000;
        const bytesPerSecond = (bitrateKbps * 1000) / 8;
        const bytesToSkip = Math.floor(positionMs / 1000 * bytesPerSecond);
        
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

    // ОСНОВНОЕ ИЗМЕНЕНИЕ: ТОЛЬКО 5-СЕКУНДНАЯ ТИШИНА БЕЗ ЗАДЕРЖЕК
    readStream.on('end', () => {
        if (!res.finished) {
            // ОТПРАВЛЯЕМ 5 СЕКУНД ТИШИНЫ (80000 БАЙТ)
            const silence = Buffer.alloc(80000, 0);
            res.write(silence);
        }
    });

    readStream.on('error', (err) => {
        console.error('❌ Ошибка отправки трека:', err);
        if (!res.finished) {
            res.end();
        }
    });
}

const server = http.createServer(async (req, res) => {
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
                res.end(JSON.stringify({ 
                    success: false, 
                    message: 'Не указано название трека' 
                }));
                return;
            }
            
            console.log(`📨 POST запрос на добавление: "${track}"`);
            
            try {
                // 🔑 ЖДЕМ РЕЗУЛЬТАТА ДОБАВЛЕНИЯ ТРЕКА ПЕРЕД ОТПРАВКОЙ ОТВЕТА
                const result = await addTrackToQueue(track);
                
                if (result.success) {
                    res.writeHead(200, { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type'
                    });
                    
                    // 🔑 ВОЗВРАЩАЕМ ПОЗИЦИЮ И КОЛИЧЕСТВО ТРЕКОВ ДО ВОСПРОИЗВЕДЕНИЯ
                    res.end(JSON.stringify({ 
                        success: true, 
                        message: `Трек добавлен на позицию ${result.position}`,
                        position: result.position,
                        tracksUntilPlayback: result.tracksUntilPlayback
                    }));
                    
                    console.log(`✅ Трек добавлен на позицию ${result.position}`);
                    console.log(`⏳ Начнёт воспроизводиться через ${result.tracksUntilPlayback} треков`);
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        message: result.error || 'Не удалось добавить трек'
                    }));
                    console.error('❌ Ошибка добавления:', result.error);
                }
            } catch (error) {
                console.error('❌ Ошибка обработки трека:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: false, 
                    message: 'Ошибка сервера при обработке трека'
                }));
            }
        } catch (parseError) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: false, 
                message: 'Некорректный JSON в запросе' 
            }));
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
        if (audioFilesCache.length === 0) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Нет аудиофайлов');
            return;
        }

        console.log(`🎧 Новый клиент подключился (всего: ${activeConnections.size + 1})`);

        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });

        if (isPlaying && trackStartTime > 0 && currentTrackIndex >= 0 && currentTrackIndex < audioFilesCache.length) {
            const currentTrack = audioFilesCache[currentTrackIndex];
            const safePosition = Math.min(currentPlaybackPosition, currentTrack.duration - 100);

            console.log(`🎧 Новый клиент: текущий трек "${currentTrack.name}", позиция: ${Math.round(safePosition / 1000)}с`);
            sendTrackFromPosition(res, currentTrack, safePosition);
            activeConnections.add(res);
            return;
        }

        if (audioFilesCache.length > 0) {
            const firstTrack = audioFilesCache[0];
            console.log(`🎧 Новый клиент: первый трек "${firstTrack.name}", позиция: 0с`);
            sendTrackFromPosition(res, firstTrack, 0);
            activeConnections.add(res);
            return;
        }

        res.end();
        return;
    }

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
server.maxConnections = 100;

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
    if (playbackInterval) {
        clearInterval(playbackInterval);
    }
    activeConnections.forEach(res => {
        if (!res.finished) res.end();
    });
    process.exit(0);
});