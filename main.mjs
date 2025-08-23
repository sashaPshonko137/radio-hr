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

// Функция для контроля скорости отправки
function createThrottledStream(readStream, bitrate = 128) {
    const bytesPerSecond = (bitrate * 1000) / 8; // 128 kbps → 16000 bytes/sec
    
    let bytesSent = 0;
    let startTime = Date.now();
    
    return new Readable({
        read(size) {
            const chunk = readStream.read(size);
            if (chunk) {
                bytesSent += chunk.length;
                
                // Вычисляем, сколько времени должно было пройти для этой скорости
                const targetTime = startTime + (bytesSent / bytesPerSecond) * 1000;
                const currentTime = Date.now();
                const delay = Math.max(0, targetTime - currentTime);
                
                if (delay > 0) {
                    setTimeout(() => {
                        this.push(chunk);
                    }, delay);
                } else {
                    this.push(chunk);
                }
            } else {
                readStream.once('readable', () => this.read(size));
            }
        }
    });
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
            const filePath = files[currentIndex];
            const fileName = path.basename(filePath, path.extname(filePath));
            
            console.log(`▶️  Начинаем воспроизведение: ${fileName}`);

            const readStream = fs.createReadStream(filePath);
            
            // Простая задержка между чанками
            readStream.on('data', (chunk) => {
                if (!res.finished) {
                    // Искусственно замедляем отправку
                    setTimeout(() => {
                        if (!res.finished) {
                            res.write(chunk);
                        }
                    }, 100); // Задержка 100ms между чанками
                }
            });

            readStream.on('end', () => {
                console.log(`✅ Трек завершен: ${fileName}`);
                currentIndex = (currentIndex + 1) % files.length;
                
                // Короткая пауза между треками (1 секунда)
                setTimeout(sendNextTrack, 1000);
            });

            readStream.on('error', (err) => {
                console.error('❌ Ошибка чтения файла:', err);
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

server.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise: http://${SERVER_IP}:${PORT}/stream.mp3

📁 Аудиофайлы из папки: ${AUDIO_DIR}
🌐 Сервер доступен по IP: ${SERVER_IP}
📻 Режим: бесконечный радио-поток
`);
});