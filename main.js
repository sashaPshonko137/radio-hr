import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, 'audio');
const PORT = 8000;

// Получаем список аудиофайлов
function getAudioFiles() {
  return fs.readdirSync(AUDIO_DIR)
    .filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.mp3', '.wav', '.ogg'].includes(ext);
    })
    .map(file => path.join(AUDIO_DIR, file));
}

// Создаём сервер
const server = http.createServer((req, res) => {
  const url = req.url;

  if (url === '/stream.mp3' || url === '/stream.wav' || url === '/stream.ogg') {
    console.log('[Подключение] Клиент подключился к стриму');

    // Определяем формат по URL
    const format = path.extname(url).toLowerCase();
    const validFormats = ['.mp3', '.wav', '.ogg'];
    const contentType = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg'
    };

    if (!validFormats.includes(format)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Поддерживаемые форматы: .mp3, .wav, .ogg');
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType[format],
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const files = getAudioFiles();
    if (files.length === 0) {
      console.error('Нет аудиофайлов!');
      res.end();
      return;
    }

    let index = 0;

    function sendNextFile() {
      const filePath = files[index];
      const readStream = fs.createReadStream(filePath);

      readStream.pipe(res, { end: false });

      readStream.on('end', () => {
        index = (index + 1) % files.length; // цикл
        console.log(`Файл отправлен: ${path.basename(filePath)}. Следующий: ${path.basename(files[index])}`);
        // Можно добавить тишину или паузу, если нужно
      });

      readStream.on('error', (err) => {
        console.error('Ошибка чтения файла:', err);
        if (!res.finished) res.end();
      });
    }

    // Начинаем с первого файла
    sendNextFile();

    // Если соединение закроется — ничего не делаем
    req.on('close', () => {
      console.log('[Отключение] Клиент отключился');
      // Можно остановить поток
    });

  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h1>Highrise Radio</h1>
      <p>Подключи в Highrise:</p>
      <code>http://твой-IP:${PORT}/stream.mp3</code>
      <br><br>
      <audio controls autoplay>
        <source src="/stream.mp3" type="audio/mpeg">
        Ваш браузер не поддерживает аудио.
      </audio>
    `);
  }
});

server.listen(PORT, () => {
  console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise: http://твой-IP:${PORT}/stream.mp3
📁 Аудиофайлы из папки: ${AUDIO_DIR}
`);
});