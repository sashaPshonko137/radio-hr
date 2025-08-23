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
                // Используем длительность по умолчанию 3 минуты
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

// Кэш файлов с длительностями
let audioFilesCache = [];

// Предзагружаем информацию о файлах
getAudioFilesWithDurations().then(files => {
    audioFilesCache = files;
    console.log(`✅ Загружено ${files.length} треков с точными длительностями`);
}).catch(err => {
    console.error('❌ Ошибка загрузки треков:', err);
});

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

        console.log('🎵 Клиент подключился к радио');

        // Устанавливаем заголовки для бесконечного потока
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });

        let currentIndex = 0;

        function sendNextTrack() {
            if (audioFilesCache.length === 0) return;

            const track = audioFilesCache[currentIndex];
            console.log(`▶️  Воспроизведение: ${track.name} (${Math.round(track.duration / 1000)} сек)`);

            // Отправляем текущий трек
            const readStream = fs.createReadStream(track.path);
            readStream.pipe(res, { end: false });

            readStream.on('end', () => {
                console.log(`✅ Трек завершен: ${track.name}`);
                
                // Переходим к следующему треку
                currentIndex = (currentIndex + 1) % audioFilesCache.length;
                
                // Ждем ТОЧНОЕ время длительности трека перед отправкой следующего
                setTimeout(sendNextTrack, track.duration);
            });

            readStream.on('error', (err) => {
                console.error('❌ Ошибка чтения файла:', err);
                // Переходим к следующему треку через короткую паузу
                currentIndex = (currentIndex + 1) % audioFilesCache.length;
                setTimeout(sendNextTrack, 1000);
            });
        }

        // Начинаем поток
        sendNextTrack();

        req.on('close', () => {
            console.log('🎧 Клиент отключился');
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
📻 Режим: бесконечный поток с ТОЧНЫМИ длительностями
`);
});