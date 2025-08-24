import { createConnection } from 'net';
import { Buffer } from 'buffer';

// ===== НАСТРОЙКИ (ИЗМЕНИТЕ ПОД СВОЙ СЛУЧАЙ) =====
const ICECAST_HOST = 'localhost';      // Обычно localhost
const ICECAST_PORT = 8000;             // Порт из icecast.xml
const MOUNT_POINT = '/highrise-radio.mp3'; // Mount point
const SOURCE_PASSWORD = 'hackme';      // source-password из icecast.xml
// ================================================

console.log(`
🔍 Запущен тест подключения к Icecast
-------------------------------------
Хост: ${ICECAST_HOST}
Порт: ${ICECAST_PORT}
Mount point: ${MOUNT_POINT}
Пароль: ${SOURCE_PASSWORD}
`);

// Шаг 1: Проверяем доступность порта
console.log('\n🔍 Шаг 1: Проверка доступности порта');
const net = await import('net');
const portCheck = new Promise((resolve) => {
    const socket = net.createConnection(ICECAST_PORT, ICECAST_HOST);
    
    socket.on('connect', () => {
        console.log('✅ Порт доступен: соединение установлено');
        socket.end();
        resolve(true);
    });
    
    socket.on('error', (err) => {
        console.error(`❌ Порт недоступен: ${err.message}`);
        console.log(`
💡 Возможные причины:
1. Icecast не запущен: sudo systemctl status icecast2
2. Неправильный порт в icecast.xml
3. Фаервол блокирует порт: sudo ufw allow ${ICECAST_PORT}
`);
        resolve(false);
    });
});

const portOpen = await portCheck;
if (!portOpen) process.exit(1);

// Шаг 2: Подключаемся к Icecast
console.log('\n🔍 Шаг 2: Попытка подключения к Icecast');
let icecastSocket = createConnection({
    host: ICECAST_HOST,
    port: ICECAST_PORT
});

// Накопление данных для полного ответа
let icecastResponse = '';

// Шаг 3: Логируем все этапы подключения
icecastSocket
    .on('connect', () => {
        console.log('✅ Соединение установлено');
        
        // Формируем заголовки аутентификации
        const auth = Buffer.from(`source:${SOURCE_PASSWORD}`).toString('base64');
        const headers = [
            `SOURCE ${MOUNT_POINT} HTTP/1.0`,
            `Authorization: Basic ${auth}`,
            'Content-Type: audio/mpeg',
            'User-Agent: IcecastTestClient/1.0',
            '', // Обязательная пустая строка
            ''  // Двойной CRLF
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
                console.log('💡 Теперь Icecast ожидает аудиопоток');
                console.log('⚠️  Для завершения теста закройте соединение...');
                
                // Отправляем небольшой тестовый поток
                setTimeout(() => {
                    console.log('\n🎵 Отправляем тестовые данные...');
                    icecastSocket.write(Buffer.alloc(1024, 0)); // Пустые данные
                }, 1000);
            } 
            else if (statusLine.includes('401 Unauthorized')) {
                console.error('\n❌ ОШИБКА: Неверный пароль!');
                console.log(`
💡 Решение:
1. Проверьте пароль в icecast.xml:
   sudo grep "source-password" /etc/icecast2/icecast.xml
   
2. Убедитесь, что в коде используется ТОТ ЖЕ пароль
`);
            }
            else {
                console.error('\n❌ ОШИБКА: Неизвестный ответ');
                console.log('Сохраните этот вывод и сравните с документацией Icecast');
            }
        }
    })
    .on('error', (err) => {
        console.error('\n❌ КРИТИЧЕСКАЯ ОШИБКА:', err.message);
        console.log(`
💡 Возможные причины:
1. Неправильный mount point
2. Icecast не поддерживает SOURCE метод
3. Сетевые проблемы
4. Icecast перегружен
`);
    })
    .on('close', (hadError) => {
        console.log('\n🔌 Соединение закрыто', hadError ? '(с ошибкой)' : '(нормально)');
        
        if (hadError) {
            console.log(`
🔍 Для диагностики:
1. Проверьте логи Icecast:
   sudo tail -f /var/log/icecast2/error.log
   
2. Проверьте конфигурацию:
   sudo cat /etc/icecast2/icecast.xml | grep -A 5 "<listen-socket>"
   
3. Проверьте пароли:
   sudo cat /etc/icecast2/icecast.xml | grep -E "password|mount"
`);
        } else {
            console.log('\n✅ Тест завершен успешно!');
        }
    });

// Шаг 4: Автоматическое закрытие через 5 секунд
setTimeout(() => {
    if (icecastSocket && icecastSocket.writable) {
        console.log('\n⏳ Завершаем тестовое соединение...');
        icecastSocket.end();
    }
}, 5000);