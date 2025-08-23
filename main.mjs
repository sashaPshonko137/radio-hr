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

        // Устанавливаем заголовки для бесконечного потока
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });

        let currentIndex = 0;
        let isPlaying = false;

        function sendNextTrack() {
            if (isPlaying) return;
            isPlaying = true;

            const filePath = files[currentIndex];
            const fileName = path.basename(filePath, path.extname(filePath));
            
            console.log(`▶️  Начинаем воспроизведение: ${fileName}`);

            // Получаем информацию о файле для расчета времени
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error('Ошибка получения информации о файле:', err);
                    isPlaying = false;
                    currentIndex = (currentIndex + 1) % files.length;
                    setTimeout(sendNextTrack, 1000);
                    return;
                }

                // Предполагаем, что 1MB ≈ 1 минута музыки (128kbps)
                const fileSizeMB = stats.size / (1024 * 1024);
                const estimatedDuration = fileSizeMB * 60000; // в миллисекундах
                
                console.log(`⏱️  Примерная длительность: ${Math.round(estimatedDuration / 1000)} сек`);

                const readStream = fs.createReadStream(filePath);
                let startTime = Date.now();
                let bytesSent = 0;

                // Функция для отправки с правильной скоростью
                function sendChunk() {
                    const chunk = readStream.read();
                    if (chunk && !res.finished) {
                        bytesSent += chunk.length;
                        
                        // Рассчитываем, когда должен быть отправлен этот чанк
                        const elapsed = Date.now() - startTime;
                        const targetTime = (bytesSent / stats.size) * estimatedDuration;
                        const delay = Math.max(0, targetTime - elapsed);
                        
                        if (delay > 0) {
                            setTimeout(() => {
                                if (!res.finished) {
                                    res.write(chunk);
                                    sendChunk();
                                }
                            }, delay);
                        } else {
                            res.write(chunk);
                            sendChunk();
                        }
                    } else if (!chunk) {
                        // Ждем новых данных
                        readStream.once('readable', sendChunk);
                    }
                }

                readStream.on('readable', sendChunk);

                readStream.on('end', () => {
                    const actualTime = Date.now() - startTime;
                    console.log(`✅ Трек завершен: ${fileName} (${Math.round(actualTime / 1000)} сек)`);
                    
                    // Ждем оставшееся время, если трек "воспроизводился" быстрее
                    const remainingTime = Math.max(0, estimatedDuration - actualTime);
                    
                    setTimeout(() => {
                        isPlaying = false;
                        currentIndex = (currentIndex + 1) % files.length;
                        sendNextTrack();
                    }, remainingTime + 1000); // +1 секунда паузы между треками
                });

                readStream.on('error', (err) => {
                    console.error('❌ Ошибка чтения файла:', err);
                    isPlaying = false;
                    currentIndex = (currentIndex + 1) % files.length;
                    setTimeout(sendNextTrack, 1000);
                });
            });
        }

        // Начинаем поток
        sendNextTrack();

        req.on('close', () => {
            console.log('🎧 Клиент отключился');
            isPlaying = false;
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
📻 Режим: бесконечный радио-поток с контролем скорости
`);
});