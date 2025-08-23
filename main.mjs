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

if (req.url === '/radio.pls') {
  const plsPath = path.join(__dirname, 'radio.pls');
  fs.readFile(plsPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Playlist not found');
    } else {
      res.writeHead(200, { 'Content-Type': 'audio/x-scpls' }); // MIME-тип для .pls
      res.end(data);
    }
  });
  return;
}
});

server.listen(PORT, () => {
  console.log(`
🚀 Сервер запущен: http://localhost:${PORT}
🎧 Подключи в Highrise: http://твой-IP:${PORT}/stream.mp3
📁 Аудиофайлы из папки: ${AUDIO_DIR}
`);
});