#!/usr/bin/env bash
# Автообновление: забирает новую версию из GitHub, прогоняет тесты и перезапускает игру.
# Не перезапускает, пока идут матчи, и откатывается, если тесты не прошли.
set -euo pipefail
APP_DIR=/opt/tri-kluba
set -a; . /etc/tri-kluba.env; set +a
[ "${AUTO_UPDATE:-1}" = 1 ] || exit 0

cd "$APP_DIR"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0

matches=$(curl -fsS http://127.0.0.1:${PORT:-8080}/status 2>/dev/null | sed -n 's/.*"matches":\([0-9]*\).*/\1/p')
if [ "${matches:-0}" != 0 ]; then echo "Идут матчи ($matches), обновлю в следующий раз"; exit 0; fi

old=$(git rev-parse HEAD)
git reset -q --hard origin/main
if (cd app && TEST_FAST=1 timeout 120 node --test >/tmp/tri-kluba-tests.log 2>&1); then
  systemctl restart tri-kluba
  echo "Обновлено: $old -> $(git rev-parse --short HEAD)"
else
  git reset -q --hard "$old"
  echo "Тесты новой версии не прошли, остаюсь на $old. Журнал: /tmp/tri-kluba-tests.log"
  exit 1
fi
