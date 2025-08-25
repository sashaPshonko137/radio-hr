# Dockerfile
FROM ubuntu:20.04

# Установка зависимостей и Liquidsoap
RUN apt-get update && \
    apt-get install -y software-properties-common && \
    add-apt-repository ppa:savonet/ppa && \
    apt-get update && \
    apt-get install -y liquidsoap && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Создаем директорию для конфигов
RUN mkdir -p /app

# Копируем конфигурационные файлы
COPY radio.liq /app/radio.liq
COPY playlist.txt /app/playlist.txt

# Устанавливаем права
WORKDIR /app

# Запускаем Liquidsoap
CMD ["liquidsoap", "/app/radio.liq"]