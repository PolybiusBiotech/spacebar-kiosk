#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/speakeasy-kiosk}"
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

if [[ ! -f /etc/speakeasy-kiosk.env ]]; then
  install -m 600 -o root -g root "$APP_DIR/.env.example" /etc/speakeasy-kiosk.env
  echo "Created /etc/speakeasy-kiosk.env. Edit it before starting the kiosk."
fi

install -m 644 "$APP_DIR/ops/speakeasy-kiosk.service" /etc/systemd/system/speakeasy-kiosk.service
install -m 644 "$APP_DIR/ops/speakeasy-kiosk-browser.service" /etc/systemd/system/speakeasy-kiosk-browser.service

systemctl daemon-reload
systemctl enable speakeasy-kiosk.service speakeasy-kiosk-browser.service

echo "Installed. Configure /etc/speakeasy-kiosk.env, then run:"
echo "  sudo systemctl restart speakeasy-kiosk.service speakeasy-kiosk-browser.service"
