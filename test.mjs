import { createConnection } from 'net';
import { createReadStream } from 'fs';
import { Buffer } from 'buffer';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ===== НАСТРОЙКИ =====
const ICECAST_HOST = 'localhost';
const ICECAST_PORT = 8000;
const MOUNT_POINT = '/highrise-radio.mp3';
const SOURCE_PASSWORD = 'hackme';

// Папка с аудиофайлами (все MP3 из этой папки будут в очереди)
const AUDIO_DIR = './audio'; // Убедитесь, что путь правильный
// =====================

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log(`
🔊 ЗАПУЩЕН ПОСТОЯННЫЙ ПОТОК в Icecast
=================================================
Хост: ${ICECAST_HOST}
Порт: ${ICECAST_PORT}
Mount point: ${MOUNT_POINT}
Пароль: ${SOURCE_PASSWORD}
Аудиофайлы из: ${AUDIO_DIR}
`);

let icecastSocket = null;
let icecastResponse = '';
let currentTrackIndex = 0;
let audioFiles = [];
let isStreaming = false;

// Шаг 1: Проверка папки с аудиофайлами
console.log('\n🔍 Шаг 1: Проверка аудиофайлов');
try {
    const fs = await import('fs');
    const path = await import('path');
    
    if (!fs.existsSync(AUDIO_DIR)) {
        console.error(`❌ Папка не найдена: ${AUDIO_DIR}`);
        console.log(`💡 Создайте папку и положите туда MP3 файлы`);
        process.exit(1);
    }
    
    audioFiles = fs.readdirSync(AUDIO_DIR)
        .filter(file => path.extname(file).toLowerCase() === '.mp3')
        .map(file => path.join(AUDIO_DIR, file));
    
    if (audioFiles.length === 0) {
        console.error(`❌ Нет MP3 файлов в папке: ${AUDIO_DIR}`);
        console.log(`💡 Положите хотя бы один MP3 файл в папку`);
        process.exit(1);
    }
    
    console.log(`✅ Найдено ${audioFiles.length} MP3 файлов:`);
    audioFiles.forEach((file, i) => {
        console.log(`   ${i + 1}. ${path.basename(file)}`);
    });
    
} catch (err) {
    console.error(`❌ Ошибка чтения папки: ${err.message}`);
    process.exit(1);
}

// Шаг 2: Проверка доступности порта
console.log('\n🔍 Шаг 2: Проверка доступности порта');
const portCheck = new Promise((resolve) => {
    const socket = createConnection(ICECAST_PORT, ICECAST_HOST);
    
    socket.on('connect', () => {
        console.log('✅ Порт доступен: соединение установлено');
        socket.end();
        resolve(true);
    });
    
    socket.on('error', (err) => {
        console.error(`❌ Порт недоступен: ${err.message}`);
        resolve(false);
    });
});

const portOpen = await portCheck;
if (!portOpen) process.exit(1);

// Шаг 3: Подключение к Icecast (один раз на всё время)
function connectToIcecast() {
    if (icecastSocket) {
        icecastSocket.destroy();
        icecastSocket = null;
    }
    
    console.log('\n🔄 Создаем постоянное соединение с Icecast...');
    icecastSocket = createConnection({
        host: ICECAST_HOST,
        port: ICECAST_PORT,
        timeout: 10000
    });

    icecastSocket
        .on('connect', () => {
            console.log('✅ Постоянное соединение установлено');
            
            const auth = Buffer.from(`source:${SOURCE_PASSWORD}`).toString('base64');
            const headers = [
                `SOURCE ${MOUNT_POINT} HTTP/1.0`,
                `Authorization: Basic ${auth}`,
                'Content-Type: audio/mpeg',
                'User-Agent: IcecastPermanentStream/1.0',
                'Accept: */*',
                '',
                ''
            ].join('\r\n');
            
            console.log('\n📤 Отправляем заголовки аутентификации:');
            console.log('----------------------------------------');
            console.log(headers);
            console.log('----------------------------------------');
            
            icecastSocket.write(headers);
        })
        .on('data', (data) => {
            const chunk = data.toString();
            icecastResponse += chunk;
            
            console.log('\n📥 Ответ от Icecast:');
            console.log('----------------------------------------');
            console.log(chunk.split('\n')[0]); // Только первая строка
            console.log('----------------------------------------');
            
            if (icecastResponse.includes('\r\n\r\n')) {
                const statusLine = icecastResponse.split('\n')[0].trim();
                
                if (statusLine.includes('200 OK')) {
                    console.log('\n🎉 УСПЕХ: Аутентификация прошла!');
                    console.log('🔊 ПОТОК ГОТОВ К ОТПРАВКЕ АУДИО');
                    startNextTrack(); // Запускаем первый трек
                } 
                else if (statusLine.includes('401 Unauthorized')) {
                    console.error('\n❌ ОШИБКА: Неверный пароль!');
                    showPasswordDebug();
                    process.exit(1);
                }
            }
        })
        .on('error', (err) => {
            console.error('\n❌ ОШИБКА соединения:', err.message);
            console.log('🔄 Попытка переподключения через 5 сек...');
            setTimeout(connectToIcecast, 5000);
        })
        .on('close', (hadError) => {
            console.log('\n🔌 Соединение закрыто', hadError ? '(с ошибкой)' : '(нормально)');
            console.log('🔄 Пытаемся восстановить поток...');
            setTimeout(connectToIcecast, 2000);
        })
        .on('timeout', () => {
            console.error('\n⏰ Таймаут подключения');
            icecastSocket.destroy();
        });
}

function showPasswordDebug() {
    console.log(`
💡 ПРОВЕРЬТЕ ПАРОЛЬ:
1. В коде: "${SOURCE_PASSWORD}"
2. В /etc/icecast2/icecast.xml: source-password
3. Base64: ${Buffer.from(`source:${SOURCE_PASSWORD}`).toString('base64')}
`);
}

// Шаг 4: Отправка трека БЕЗ закрытия соединения
async function sendTrack(trackPath) {
    const path = await import('path');
    const trackName = path.basename(trackPath);
    
    console.log(`\n🎵 НАЧИНАЕМ ОТПРАВКУ ТРЕКА: ${trackName}`);
    isStreaming = true;
    
    const readStream = createReadStream(trackPath, {
        highWaterMark: 8192
    });
    
    let bytesSent = 0;
    let chunksSent = 0;
    
    readStream
        .on('open', () => {
            console.log(`✅ Файл открыт: ${trackName}`);
        })
        .on('data', (chunk) => {
            if (icecastSocket && icecastSocket.writable) {
                icecastSocket.write(chunk, (err) => {
                    if (err) {
                        console.error('❌ Ошибка отправки чанка:', err.message);
                        return;
                    }
                    
                    bytesSent += chunk.length;
                    chunksSent++;
                    
                    if (chunksSent % 20 === 0) {
                        process.stdout.write(`\r📤 Отправлено: ${Math.round(bytesSent / 1024)} KB`);
                    }
                });
            }
        })
        .on('end', () => {
            console.log(`\n🏁 ТРЕК ЗАВЕРШЁН: ${trackName}`);
            console.log(`📊 Итого: ${chunksSent} чанков, ${Math.round(bytesSent / 1024)} KB`);
            
            // ⚠️ НЕ ЗАКРЫВАЕМ СОЕДИНЕНИЕ!
            // Вместо этого — запускаем следующий трек
            setTimeout(startNextTrack, 100);
        })
        .on('error', (err) => {
            console.error(`❌ Ошибка чтения трека: ${err.message}`);
            setTimeout(startNextTrack, 1000);
        });
}

// Управление очередью
function startNextTrack() {
    if (audioFiles.length === 0) {
        console.log('⏸️  Очередь пуста, ждём...');
        return;
    }
    
    const track = audioFiles[currentTrackIndex];
    currentTrackIndex = (currentTrackIndex + 1) % audioFiles.length;
    
    sendTrack(track);
}

// Запуск
console.log('\n🚀 ЗАПУСК ПОСТОЯННОГО ПОТОКА...');
connectToIcecast();

// Информация о системе
setTimeout(() => {
    console.log('\n📋 Система:');
    console.log(`Node.js: ${process.version}`);
    console.log(`Папка: ${__dirname}`);
}, 1000);

// Мониторинг
setInterval(() => {
    if (icecastSocket && icecastSocket.readyState === 'open' && !isStreaming) {
        console.log(`\n🔄 Ожидаем следующий трек...`);
    }
}, 10000);

// Обработка остановки
process.on('SIGINT', () => {
    console.log('\n🛑 ОСТАНАВЛИВАЕМ ПОТОК...');
    
    // ❌ НЕ ЗАКРЫВАЕМ СОЕДИНЕНИЕ!
    // Icecast сам закроет mount point при разрыве
    if (icecastSocket) {
        icecastSocket.destroy(); // Только при остановке сервера
    }
    
    console.log('✅ Поток остановлен');
    process.exit(0);
});

// Дополнительные проверки
setTimeout(async () => {
    try {
        const { exec } = await import('child_process');
        
        exec('systemctl is-active icecast2', (err, stdout) => {
            console.log(`✅ Icecast: ${stdout.trim()}`);
        });
        
        exec("grep 'bind-address' /etc/icecast2/icecast.xml", (err, stdout) => {
            console.log(`🌐 bind-address: ${stdout.trim() || 'не найден'}`);
        });
        
    } catch (err) {
        console.log('ℹ️  Не удалось проверить систему');
    }
}, 2000);