#!/usr/bin/env bash
# Установка «Трёх клубов» на чистый сервер Ubuntu 24.04.
# Запуск (от root):  bash setup.sh игра.пример.ru
# Повторный запуск безопасен: ничего не ломает и не трогает базу.
set -euo pipefail

DOMAIN="${1:?Укажите домен: bash setup.sh game.example.ru}"
REPO="${REPO:-https://github.com/ez535/tri-kluba.git}"
APP_DIR=/opt/tri-kluba
DATA_DIR=/var/lib/tri-kluba
ENV_FILE=/etc/tri-kluba.env

[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo bash setup.sh $DOMAIN"; exit 1; }
. /etc/os-release
[ "${VERSION_ID:-}" = 24.04 ] || echo "Внимание: скрипт проверен на Ubuntu 24.04, у вас ${PRETTY_NAME:-неизвестная система}."
echo "==> Пакеты: git, caddy (веб-сервер с автоматическим HTTPS), sqlite3"
apt-get update -q
apt-get install -y -q git caddy sqlite3 curl xz-utils ca-certificates

echo "==> Node.js 22"
need_node=1
if command -v node >/dev/null; then
  v=$(node -p 'process.versions.node'); IFS=. read -r ma mi _ <<<"$v"
  if [ "$ma" -gt 22 ] || { [ "$ma" -eq 22 ] && [ "$mi" -ge 13 ]; }; then need_node=0; fi
fi
if [ $need_node = 1 ]; then
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo "Неизвестная архитектура"; exit 1 ;; esac
  base=https://nodejs.org/dist/latest-v22.x
  file=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2}')
  curl -fsSL "$base/$file" -o /tmp/node.tar.xz
  curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sed "s# $file# /tmp/node.tar.xz#" | sha256sum -c -
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
  rm /tmp/node.tar.xz
fi
node --version

echo "==> Пользователь и папки"
id tk >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin tk
mkdir -p "$DATA_DIR" /var/backups/tri-kluba
chown tk:tk "$DATA_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull -q --ff-only; else git clone -q "$REPO" "$APP_DIR"; fi

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# Настройки игры. После правки: systemctl restart tri-kluba
PUBLIC_URL=https://$DOMAIN
PORT=8080
DATA_DIR=$DATA_DIR
# Токен бота от @BotFather (секрет, никому не показывать):
BOT_TOKEN=
# Короткое имя Mini App из @BotFather (/newapp), например play:
APP_SHORT_NAME=
# Куда копировать ночную копию базы (резерв у другого российского провайдера), например root@IP-резерва:/var/backups/tri-kluba
RESERVE_SSH=
# Автообновление из GitHub: 1 — включено, 0 — выключено
AUTO_UPDATE=1
EOF
fi
chmod 600 "$ENV_FILE"

echo "==> Служба игры"
cat > /etc/systemd/system/tri-kluba.service <<EOF
[Unit]
Description=Три клуба — игровой сервер
After=network-online.target
Wants=network-online.target

[Service]
User=tk
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR/app
ExecStart=/usr/local/bin/node server/server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

for job in update backup; do
  cat > /etc/systemd/system/tri-kluba-$job.service <<EOF
[Unit]
Description=Три клуба — $job

[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/deploy/$job.sh
EOF
done
cat > /etc/systemd/system/tri-kluba-update.timer <<EOF
[Unit]
Description=Три клуба — проверка обновлений каждые 10 минут
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/tri-kluba-backup.timer <<EOF
[Unit]
Description=Три клуба — ночная копия базы
[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

echo "==> HTTPS и адрес $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:8080
}
EOF

systemctl daemon-reload
systemctl enable --now tri-kluba tri-kluba-update.timer tri-kluba-backup.timer
systemctl restart tri-kluba
systemctl reload caddy || systemctl restart caddy

sleep 2
if curl -fsS http://127.0.0.1:8080/health >/dev/null; then
  echo
  echo "Готово. Игра: https://$DOMAIN"
  echo "Если сайт не открывается, проверьте, что домен указывает на этот сервер (A-запись) и открыты порты 80 и 443."
else
  echo "Сервер игры не ответил. Посмотрите журнал: journalctl -u tri-kluba -n 50"; exit 1
fi
