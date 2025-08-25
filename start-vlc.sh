#!/bin/bash

# Путь к вашей аудио-папке
AUDIO_DIR="/root/radio-hr/audio"

# Запускаем VLC
cvlc \
  --sout "#transcode{acodec=mp3,ab=128}:http{dst=:8000/}" \
  --loop \
  "$AUDIO_DIR"