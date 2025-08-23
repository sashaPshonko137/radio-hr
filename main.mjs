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

        // Устанавливаем заголовки
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'close'
        });

        // Просто отправляем один случайный трек и закрываем соединение
        const randomIndex = Math.floor(Math.random() * files.length);
        const filePath = files[randomIndex];
        const fileName = path.basename(filePath, path.extname(filePath));
        
        console.log(`▶️  Отправляем: ${fileName}`);

        // Отправляем файл целиком
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);

        fileStream.on('end', () => {
            console.log(`✅ Файл отправлен: ${fileName}`);
        });

        fileStream.on('error', (err) => {
            console.error('❌ Ошибка чтения файла:', err);
            res.end();
        });

        req.on('close', () => {
            console.log('🎧 Клиент отключился');
        });

        return;
    }

    // Для всех остальных запросов - простой текст
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Highrise Radio Server\nИспользуйте /stream.mp3 для получения аудио');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise: http://${SERVER_IP}:${PORT}/stream.mp3

📁 Аудиофайлы из папки: ${AUDIO_DIR}
🌐 Сервер доступен по IP: ${SERVER_IP}
📻 Режим: один трек на подключение
`);
});