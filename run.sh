#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-4568}"
exec python app.py
