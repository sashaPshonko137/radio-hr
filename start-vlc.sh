#!/bin/bash

# Путь к вашей аудио-папке
AUDIO_DIR="/root/radio-hr/audio"

# Запускаем VLC
cvlc \
  --intf http \
  --http-port 8080 \
  --http-password "hackme" \
  --sout "#transcode{acodec=mp3,ab=128,channels=2,samplerate=44100}:http{mux=mp3,dst=:8000/}" \
  --loop \
  "$AUDIO_DIR"