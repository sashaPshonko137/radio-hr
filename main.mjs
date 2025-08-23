import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

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

// Получаем список аудиофайлов
function getAudioFiles() {
    try {
        return fs.readdirSync(AUDIO_DIR)
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.mp3', '.wav', '.ogg'].includes(ext);
            })
            .map(file => path.join(AUDIO_DIR, file));
    } catch (err) {
        console.error('Ошибка чтения папки audio:', err);
        return [];
    }
}

// Простая функция для оценки длительности MP3 (1MB ≈ 1 минута при 128kbps)
function estimateDuration(filePath) {
    try {
        const stats = fs.statSync(filePath);
        const fileSizeMB = stats.size / (1024 * 1024);
        const durationMs = fileSizeMB * 60000; // 1MB = 60000ms (1 минута)
        return Math.max(30000, Math.min(durationMs, 600000)); // от 30 сек до 10 мин
    } catch (error) {
        console.error('Ошибка оценки длительности:', error);
        return 180000; // 3 минуты по умолчанию
    }
}

// Создаём сервер
const server = http.createServer((req, res) => {
    // Обслуживаем только аудиопоток
    if (req.url === '/stream.mp3') {
        const files = getAudioFiles();
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

        function sendNextTrack() {
            if (files.length === 0) return;

            const filePath = files[currentIndex];
            const fileName = path.basename(filePath, path.extname(filePath));
            const duration = estimateDuration(filePath);
            
            console.log(`▶️  Воспроизведение: ${fileName} (${Math.round(duration / 1000)} сек)`);

            // Отправляем текущий трек
            const readStream = fs.createReadStream(filePath);
            readStream.pipe(res, { end: false });

            readStream.on('end', () => {
                console.log(`✅ Трек завершен: ${fileName}`);
                
                // Переходим к следующему треку
                currentIndex = (currentIndex + 1) % files.length;
                
                // Ждем точное время длительности трека перед отправкой следующего
                setTimeout(sendNextTrack, duration);
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
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise: http://${SERVER_IP}:${PORT}/stream.mp3

📁 Аудиофайлы из папки: ${AUDIO_DIR}
🌐 Сервер доступен по IP: ${SERVER_IP}
📻 Режим: бесконечный поток с оценкой длительностей
`);
});