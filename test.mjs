import { createConnection } from 'net';
import { createReadStream } from 'fs';
import { Buffer } from 'buffer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ===== НАСТРОЙКИ =====
const ICECAST_HOST = 'localhost';
const ICECAST_PORT = 8000;
const MOUNT_POINT = '/highrise-radio.mp3';
const SOURCE_PASSWORD = 'hackme';
const AUDIO_FILE_PATH = './audio/baby-shark.mp3'; // Укажите путь к вашему MP3 файлу
// =====================

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log(`
🔊 Запущен ТЕСТ ОТПРАВКИ АУДИО в Icecast
=================================================
Хост: ${ICECAST_HOST}
Порт: ${ICECAST_PORT}
Mount point: ${MOUNT_POINT}
Пароль: ${SOURCE_PASSWORD}
Аудиофайл: ${AUDIO_FILE_PATH}
`);

// Шаг 1: Проверка существования аудиофайла
console.log('\n🔍 Шаг 1: Проверка аудиофайла');
try {
    const fs = await import('fs');
    const stats = fs.statSync(AUDIO_FILE_PATH);
    console.log(`✅ Файл найден: ${stats.size} байт`);
    
    // Проверим, что это действительно MP3
    const buffer = Buffer.alloc(3);
    const fd = fs.openSync(AUDIO_FILE_PATH, 'r');
    fs.readSync(fd, buffer, 0, 3, 0);
    fs.closeSync(fd);
    
    if (buffer.toString('hex') === '494433') {
        console.log('✅ Формат: MP3 (ID3 tag найден)');
    } else {
        console.warn('⚠️  Внимание: Файл может быть не MP3. Первые байты:', buffer.toString('hex'));
    }
} catch (err) {
    console.error(`❌ Файл не найден: ${err.message}`);
    console.log(`
💡 Решение:
1. Создайте тестовый файл:
   ffmpeg -f lavfi -i "sine=frequency=440:duration=10" -c:a libmp3lame test-audio.mp3

2. Или укажите путь к существующему MP3 файлу в AUDIO_FILE_PATH
`);
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

// Шаг 3: Подключение к Icecast с подробным логированием
console.log('\n🔍 Шаг 3: Подключение к Icecast');
let icecastSocket = null;
let icecastResponse = '';
let audioStream = null;
let bytesSent = 0;
let chunksSent = 0;

function connectToIcecast() {
    // Закрываем предыдущее соединение
    if (icecastSocket) {
        icecastSocket.destroy();
        icecastSocket = null;
    }
    
    console.log('\n🔄 Создаем новое соединение...');
    icecastSocket = createConnection({
        host: ICECAST_HOST,
        port: ICECAST_PORT,
        timeout: 10000
    });

    // Логируем все этапы
    icecastSocket
        .on('connect', () => {
            console.log('✅ Соединение установлено');
            
            // Формируем заголовки
            const auth = Buffer.from(`source:${SOURCE_PASSWORD}`).toString('base64');
            const headers = [
                `SOURCE ${MOUNT_POINT} HTTP/1.0`,
                `Authorization: Basic ${auth}`,
                'Content-Type: audio/mpeg',
                'User-Agent: IcecastAudioTest/1.0',
                'Accept: */*',
                '',
                ''
            ].join('\r\n');
            
            console.log('\n📤 Отправляем заголовки:');
            console.log('----------------------------------------');
            console.log(headers);
            console.log('----------------------------------------');
            
            icecastSocket.write(headers);
        })
        .on('data', (data) => {
            const chunk = data.toString();
            icecastResponse += chunk;
            
            console.log('\n📥 Получен ответ от Icecast:');
            console.log('----------------------------------------');
            console.log(chunk);
            console.log('----------------------------------------');
            
            // Проверяем полный ответ
            if (icecastResponse.includes('\r\n\r\n')) {
                const statusLine = icecastResponse.split('\n')[0].trim();
                console.log(`\n🔍 Статус ответа: ${statusLine}`);
                
                if (statusLine.includes('200 OK')) {
                    console.log('\n🎉 УСПЕХ: Аутентификация прошла!');
                    console.log('🔊 ГОТОВЫ ОТПРАВЛЯТЬ АУДИО...');
                    startAudioStream();
                } 
                else if (statusLine.includes('401 Unauthorized')) {
                    console.error('\n❌ ОШИБКА: Неверный пароль!');
                    showPasswordDebug();
                }
                else {
                    console.error(`\n❌ ОШИБКА: ${statusLine}`);
                }
            }
        })
        .on('error', (err) => {
            console.error('\n❌ КРИТИЧЕСКАЯ ОШИБКА:', err.message);
            console.log('🔌 Закрываем соединение...');
            if (audioStream) audioStream.destroy();
        })
        .on('close', (hadError) => {
            console.log('\n🔌 Соединение закрыто', hadError ? '(с ошибкой)' : '(нормально)');
            console.log(`📊 Итого: ${chunksSent} чанков, ${bytesSent} байт`);
            
            if (hadError && icecastResponse) {
                console.log('\n📝 Последний ответ Icecast:');
                console.log(icecastResponse);
            }
        })
        .on('timeout', () => {
            console.error('\n⏰ Таймаут подключения');
            icecastSocket.destroy();
        });
}

function showPasswordDebug() {
    console.log(`
💡 ДЕБАГ ПАРОЛЯ:
1. Пароль в коде: "${SOURCE_PASSWORD}"
2. Base64 кодировка: ${Buffer.from(`source:${SOURCE_PASSWORD}`).toString('base64')}
3. Проверьте пароль в icecast.xml:
   sudo grep "source-password" /etc/icecast2/icecast.xml
4. Убедитесь, что mount point совпадает:
   sudo grep -A 5 "mount-name" /etc/icecast2/icecast.xml
`);
}

function startAudioStream() {
    console.log('\n🎵 Запуск аудиопотока...');
    
    // Создаем поток чтения
    audioStream = createReadStream(AUDIO_FILE_PATH, {
        highWaterMark: 8192, // Размер чанка 8KB
        autoClose: true
    });
    
    let streamStarted = false;
    let firstChunk = true;
    
    audioStream
        .on('open', () => {
            console.log('✅ Аудиофайл открыт для чтения');
        })
        .on('data', (chunk) => {
            if (!streamStarted) {
                console.log('🔊 Начало отправки аудиоданных');
                streamStarted = true;
            }
            
            if (firstChunk) {
                console.log(`\n📊 Информация о первом чанке:`);
                console.log(`   Размер: ${chunk.length} байт`);
                console.log(`   Первые 20 байт: ${chunk.slice(0, 20).toString('hex')}`);
                firstChunk = false;
            }
            
            // Отправляем чанк в Icecast
            if (icecastSocket && icecastSocket.writable) {
                icecastSocket.write(chunk, (err) => {
                    if (err) {
                        console.error('❌ Ошибка отправки чанка:', err.message);
                        return;
                    }
                    
                    bytesSent += chunk.length;
                    chunksSent++;
                    
                    // Логируем каждые 10 чанков
                    if (chunksSent % 10 === 0) {
                        console.log(`📤 Отправлено: ${chunksSent} чанков, ${bytesSent} байт`);
                    }
                });
            }
        })
        .on('end', () => {
            console.log('\n🏁 Аудиофайл полностью отправлен');
            console.log(`📊 Итого: ${chunksSent} чанков, ${bytesSent} байт`);
            
            // Завершаем соединение
            if (icecastSocket && icecastSocket.writable) {
                console.log('🔌 Закрываем соединение с Icecast...');
                icecastSocket.end();
            }
        })
        .on('error', (err) => {
            console.error('❌ Ошибка чтения аудиофайла:', err.message);
            if (icecastSocket) icecastSocket.destroy();
        })
        .on('close', () => {
            console.log('✅ Аудиопоток закрыт');
        });
    
    // Обработка ошибок потока
    audioStream.on('error', (err) => {
        console.error('❌ Ошибка аудиопотока:', err.message);
    });
}

// Запуск теста
console.log('\n🚀 ЗАПУСК ТЕСТА...');
connectToIcecast();

// Информация о системе
setTimeout(() => {
    console.log('\n📋 Информация о системе:');
    console.log(`Node.js: ${process.version}`);
    console.log(`Платформа: ${process.platform} ${process.arch}`);
    console.log(`Рабочая директория: ${__dirname}`);
}, 1000);

// Мониторинг каждые 5 секунд
setInterval(() => {
    if (icecastSocket && icecastSocket.readyState === 'open') {
        console.log(`\n🔄 Состояние: Подключено, ожидаем данные...`);
    }
}, 5000);

// Обработка завершения
process.on('SIGINT', () => {
    console.log('\n🛑 Прерываем тест...');
    if (icecastSocket) icecastSocket.destroy();
    if (audioStream) audioStream.destroy();
    process.exit(0);
});

// Дополнительные проверки при запуске
console.log('\n🔍 Дополнительные проверки:');
setTimeout(async () => {
    try {
        const { exec } = await import('child_process');
        
        // Проверка статуса Icecast
        exec('systemctl is-active icecast2', (err, stdout) => {
            if (stdout.trim() === 'active') {
                console.log('✅ Icecast: активен');
            } else {
                console.error('❌ Icecast: неактивен');
            }
        });
        
        // Проверка bind-address
        exec("grep 'bind-address' /etc/icecast2/icecast.xml", (err, stdout) => {
            console.log(`🌐 bind-address: ${stdout.trim() || 'не найден'}`);
        });
        
    } catch (err) {
        console.log('ℹ️  Не удалось выполнить системные проверки');
    }
}, 2000);