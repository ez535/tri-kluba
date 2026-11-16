#!/usr/bin/env bash
# Ночная копия базы: хранит 14 последних дней и, если задан RESERVE_SSH, отправляет копию на резервный сервер.
set -euo pipefail
set -a; . /etc/tri-kluba.env; set +a
DEST=/var/backups/tri-kluba
mkdir -p "$DEST"
f="$DEST/game-$(date +%F).sqlite"
sqlite3 "${DATA_DIR:-/var/lib/tri-kluba}/game.sqlite" ".backup '$f'"
gzip -f "$f"
find "$DEST" -name 'game-*.sqlite.gz' -mtime +14 -delete
if [ -n "${RESERVE_SSH:-}" ]; then
  scp -q -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$f.gz" "$RESERVE_SSH/" && echo "Копия отправлена на резервный сервер"
fi
echo "Копия базы: $f.gz"
