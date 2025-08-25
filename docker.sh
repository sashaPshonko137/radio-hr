docker run -d \
  --name highrise-radio \
  -p 8000:8000 \
  -p 1234:1234 \
  -v "$(pwd)/playlist.txt:/app/playlist.txt" \
  -v "$(pwd)/radio.liq:/app/radio.liq" \
  -v "$(pwd):/media" \
  savonet/liquidsoap:latest \
  /app/radio.liq