#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/spacebar-kiosk}"
APP_USER="${APP_USER:-pi}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script with sudo on the Raspberry Pi." >&2
  exit 1
fi

install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .env \
  ./ "$APP_DIR"/

(cd "$APP_DIR" && npm install --omit=dev)
chown -R "$APP_USER":"$APP_USER" "$APP_DIR/node_modules"

if [[ ! -f /etc/spacebar-kiosk.env ]]; then
  install -m 600 -o root -g root "$APP_DIR/.env.example" /etc/spacebar-kiosk.env
  echo "Created /etc/spacebar-kiosk.env. Edit it before starting the kiosk."
fi

sed "s/__APP_USER__/$APP_USER/g" "$APP_DIR/ops/spacebar-kiosk.service" | install -m 644 /dev/stdin /etc/systemd/system/spacebar-kiosk.service
sed "s/__APP_USER__/$APP_USER/g" "$APP_DIR/ops/spacebar-kiosk-browser.service" | install -m 644 /dev/stdin /etc/systemd/system/spacebar-kiosk-browser.service

systemctl daemon-reload
systemctl enable spacebar-kiosk.service spacebar-kiosk-browser.service

echo "Installed. Configure /etc/spacebar-kiosk.env, then run:"
echo "  sudo systemctl restart spacebar-kiosk.service spacebar-kiosk-browser.service"
