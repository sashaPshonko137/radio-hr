import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import musicMetadata from 'music-metadata';

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

// Получаем список аудиофайлов с их длительностями
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
                const metadata = await musicMetadata.parseFile(filePath);
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

// Создаём сервер
const server = http.createServer(async (req, res) => {
    // Обслуживаем только аудиопоток
    if (req.url === '/stream.mp3') {
        const files = await getAudioFilesWithDurations();
        if (files.length === 0) {
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

        async function sendNextTrack() {
            if (files.length === 0) return;

            const track = files[currentIndex];
            console.log(`▶️  Воспроизведение: ${track.name} (${Math.round(track.duration / 1000)} сек)`);

            // Отправляем текущий трек
            const readStream = fs.createReadStream(track.path);
            readStream.pipe(res, { end: false });

            readStream.on('end', () => {
                console.log(`✅ Трек завершен: ${track.name}`);
                
                // Переходим к следующему треку
                currentIndex = (currentIndex + 1) % files.length;
                
                // Ждем точное время длительности трека перед отправкой следующего
                setTimeout(sendNextTrack, track.duration);
            });

            readStream.on('error', (err) => {
                console.error('❌ Ошибка чтения файла:', err);
                // Переходим к следующему треку через короткую паузу
                currentIndex = (currentIndex + 1) % files.length;
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
getAudioFilesWithDurations().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise: http://${SERVER_IP}:${PORT}/stream.mp3

📁 Аудиофайлы из папки: ${AUDIO_DIR}
🌐 Сервер доступен по IP: ${SERVER_IP}
📻 Режим: бесконечный поток с точными длительностями
`);
    });
});