#!/usr/bin/env bash
# Privileged cutover: system nginx off, Tailscale Serve on 8443, TTMFlow nginx on 80/443.
set -euo pipefail

PREFIX=/mnt/Websites/TTMFlow/ifc-pipeline/nginx
UNIT_SRC=/mnt/Websites/MagicTODO/deploy/ttmflow-nginx.service

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo bash "$0" "$@"
fi

echo "Disabling system nginx..."
systemctl disable --now nginx

echo "Moving Tailscale Serve to :8443..."
tailscale serve reset
tailscale serve --bg --https=8443 --yes http://127.0.0.1:8010
tailscale serve status

if [[ -f "$PREFIX/logs/nginx.pid" ]]; then
  old=$(tr -d '[:space:]' < "$PREFIX/logs/nginx.pid")
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    echo "Stopping leftover TTMFlow nginx pid $old"
    nginx -p "$PREFIX" -c "$PREFIX/conf/nginx.conf" -s quit || kill "$old" || true
    sleep 1
  else
    rm -f "$PREFIX/logs/nginx.pid"
  fi
fi

echo "Testing TTMFlow nginx config..."
nginx -p "$PREFIX" -c "$PREFIX/conf/nginx.conf" -t

echo "Installing ttmflow-nginx.service..."
cp "$UNIT_SRC" /etc/systemd/system/ttmflow-nginx.service
systemctl daemon-reload
systemctl enable --now ttmflow-nginx
systemctl --no-pager --full status ttmflow-nginx

echo "Done. Public :80/:443 should be TTMFlow nginx; Tailscale HTTPS is :8443."
