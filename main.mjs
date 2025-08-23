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
    const url = req.url;

    // === 1. Обслуживаем .pls плейлист ===
    if (req.url === '/radio.pls') {
        const plsContent = `[playlist]
NumberOfEntries=1
File1=http://${SERVER_IP}:${PORT}/stream.mp3
Title1=Highrise Radio
Length1=-1
Version=2
`;

        res.writeHead(200, { 
            'Content-Type': 'audio/x-scpls',
            'Cache-Control': 'no-cache'
        });
        res.end(plsContent);
        return;
    }

    // === 2. Обслуживаем аудиопоток ===
    if (req.url === '/stream.mp3') {
        console.log('[Подключение] Клиент подключился к радио');

        const files = getAudioFiles();
        if (files.length === 0) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Нет аудиофайлов в папке "audio"');
            console.error('❌ Нет аудиофайлов!');
            return;
        }

        // Устанавливаем только базовые заголовки (без icy-*)
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });

        let index = 0;

        function sendNextFile() {
            const filePath = files[index];
            const fileName = path.basename(filePath, path.extname(filePath));

            console.log(`🎵 Начинаем отправку: ${fileName}`);

            const readStream = fs.createReadStream(filePath);

            // Отправляем файл клиенту
            readStream.pipe(res, { end: false });

            readStream.on('end', () => {
                index = (index + 1) % files.length;
                console.log(`✅ Файл отправлен. Следующий: ${path.basename(files[index])}`);
                setTimeout(sendNextFile, 100);
            });

            readStream.on('error', (err) => {
                console.error('❌ Ошибка чтения файла:', err);
                if (!res.finished) res.end();
            });
        }

        // Начинаем стрим
        sendNextFile();

        req.on('close', () => {
            console.log('🎧 Клиент отключился');
        });

        return;
    }

    // === 3. Главная страница (для проверки) ===
    res.writeHead(200, { 
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
    });
    res.end(`
    <h1>🎧 Highrise Radio</h1>
    <p>Подключи в Highrise:</p>
    <code>http://${SERVER_IP}:${PORT}/radio.pls</code>
    <br><br>
    <audio controls autoplay>
      <source src="/stream.mp3" type="audio/mpeg">
      Ваш браузер не поддерживает аудио.
    </audio>
    <br>
    <a href="/radio.pls">Скачать плейлист (.pls)</a>
  `);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise:
   Вариант 1 (рекомендуется): http://${SERVER_IP}:${PORT}/radio.pls
   Вариант 2: http://${SERVER_IP}:${PORT}/stream.mp3

📁 Аудиофайлы из папки: ${AUDIO_DIR}
🌐 Сервер доступен по IP: ${SERVER_IP}
`);
});