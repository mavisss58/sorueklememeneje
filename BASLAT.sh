#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "================================================================"
echo "                    SORU EKLEME UYGULAMASI"
echo "================================================================"
echo ""

if command -v node > /dev/null 2>&1; then
  exec node "$DIR/sunucu.js"
fi

echo "[UYARI] Node.js bulunamadi. Yapay zeka ile konu tespiti CALISMAYACAK."
echo "        https://nodejs.org adresinden LTS surumunu kurup tekrar calistirin."
echo ""
PORT=5500
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then
  echo "[HATA] Ne Node.js ne de Python bulundu. Lutfen Node.js kurun."
  exit 1
fi
"$PY" -m http.server $PORT --bind 127.0.0.1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
sleep 1
if command -v xdg-open > /dev/null 2>&1; then xdg-open "http://127.0.0.1:$PORT"
elif command -v open > /dev/null 2>&1; then open "http://127.0.0.1:$PORT"
else echo "Tarayicinizda su adresi acin: http://127.0.0.1:$PORT"; fi
wait $SERVER_PID
