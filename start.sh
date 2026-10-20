#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then exec python3 server.py "$@"
elif command -v python >/dev/null 2>&1; then exec python server.py "$@"
elif command -v node >/dev/null 2>&1; then exec node server.js "$@"
else echo "Flip PDF needs Python or Node.js installed."; exit 1
fi
