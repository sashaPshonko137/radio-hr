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
                
                console.log(`📊 ${path.basename(filePath)}: ${Math.round(durationMs / 1000)} сек`);
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

// Предзагружаем информацию о файлах
getAudioFilesWithDurations().then(files => {
    audioFilesCache = files;
    console.log(`✅ Загружено ${files.length} треков с точными длительностями`);
    
    // Запускаем глобальный таймер для смены треков
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
        
        console.log(`🌐 Глобально играет: ${track.name} (${Math.round(track.duration / 1000)} сек)`);
        
        // Уведомляем всех активных клиентов о смене трека
        activeConnections.forEach(res => {
            if (!res.finished) {
                // Заголовки уже отправлены, просто начинаем новый трек
                sendTrackToClient(res, track);
            }
        });

        // Планируем следующую смену трека
        setTimeout(playNextTrack, track.duration);
        
        // Переходим к следующему треку
        currentTrackIndex = (currentTrackIndex + 1) % audioFilesCache.length;
    }

    // Запускаем первый трек
    playNextTrack();
}

// Отправка трека конкретному клиенту
function sendTrackToClient(res, track) {
    console.log(`📡 Отправка клиенту: ${track.name}`);
    
    const readStream = fs.createReadStream(track.path);
    readStream.pipe(res, { end: false });

    readStream.on('error', (err) => {
        console.error('❌ Ошибка отправки трека:', err);
        if (!res.finished) {
            res.end();
        }
    });
}

// Создаём сервер
const server = http.createServer(async (req, res) => {
    // Обслуживаем только аудиопоток
    if (req.url === '/stream.mp3') {
        if (audioFilesCache.length === 0) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Нет аудиофайлов в папке "audio"');
            console.error('❌ Нет аудиофайлов!');
            return;
        }

        console.log(`🎧 Новый клиент подключился (всего: ${activeConnections.size + 1})`);

        // Добавляем клиента в активные соединения
        activeConnections.add(res);

        // Устанавливаем заголовки для бесконечного потока
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });

        // Отправляем текущий играющий трек
        const currentTrack = audioFilesCache[currentTrackIndex];
        const elapsed = Date.now() - trackStartTime;
        const remaining = Math.max(0, currentTrack.duration - elapsed);

        console.log(`⏱️  Клиент получает: ${currentTrack.name} (осталось: ${Math.round(remaining / 1000)} сек)`);

        // Если трек уже играет какое-то время, отправляем его с текущей позиции
        if (elapsed > 1000) {
            // Для простоты отправляем трек с начала, но можно реализовать seek
            sendTrackToClient(res, currentTrack);
        } else {
            sendTrackToClient(res, currentTrack);
        }

        // Обработка отключения клиента
        req.on('close', () => {
            console.log('🎧 Клиент отключился');
            activeConnections.delete(res);
        });

        return;
    }

    // Для всех остальных запросов - простой текст
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Highrise Radio Server\nИспользуйте /stream.mp3 для получения аудио');
});

// Запускаем сервер
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise: http://${SERVER_IP}:${PORT}/stream.mp3

📁 Аудиофайлы из папки: ${AUDIO_DIR}
🌐 Сервер доступен по IP: ${SERVER_IP}
📻 Режим: синхронизированный поток для всех клиентов
`);
});

// Очистка при завершении
process.on('SIGINT', () => {
    console.log('\n🛑 Выключаем сервер...');
    activeConnections.forEach(res => {
        if (!res.finished) res.end();
    });
    process.exit(0);
});