set("log.file.path", "/var/log/liquidsoap.log")
set("log.stdout", true)
set("server.telnet", false)
set("server.http", true)
set("server.http.port", 1234)

# Загружаем текущие треки
playlist = playlist(reload=30, "/app/playlist.txt")

# Функция для изменения следующего трека
def switch_next_track(uri) =
  # Помещаем новый трек в начало очереди
  request.queue.push_front(uri)
  "✅ Следующий трек изменен на: #{uri}"
end

# Регистрируем HTTP команду
server.register(
  namespace="radio",
  name="next",
  fun=(args) ->
    uri = list.assoc("uri", args)
    switch_next_track(uri)
)

# Отправляем поток на Icecast
output.icecast(
  %mp3,
  host="localhost",
  port=8000,
  password="hackme",
  mount="/highrise-radio.mp3",
  playlist
)