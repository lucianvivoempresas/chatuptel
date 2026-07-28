#!/usr/bin/env sh
set -eu
umask 077

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
CONFIG_DIR=/etc/voltconnect-chat
SECRET_DIR=/root/.config/voltconnect

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo ./deploy/install-operations.sh" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$SECRET_DIR" /var/lib/voltconnect-chat
if [ ! -f "${CONFIG_DIR}/operations.env" ]; then
  cp "${PROJECT_DIR}/deploy/operations.env.example" "${CONFIG_DIR}/operations.env"
fi
if [ ! -s "${SECRET_DIR}/backup.pass" ]; then
  openssl rand -base64 48 > "${SECRET_DIR}/backup.pass"
fi
chmod 600 "${CONFIG_DIR}/operations.env" "${SECRET_DIR}/backup.pass"
chmod +x "${PROJECT_DIR}/deploy/backup.sh" "${PROJECT_DIR}/deploy/monitor-baileys.sh"

sed "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
  "${PROJECT_DIR}/deploy/systemd/voltconnect-backup.service" \
  > /etc/systemd/system/voltconnect-backup.service
cp "${PROJECT_DIR}/deploy/systemd/voltconnect-backup.timer" \
  /etc/systemd/system/voltconnect-backup.timer
sed "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
  "${PROJECT_DIR}/deploy/systemd/voltconnect-monitor.service" \
  > /etc/systemd/system/voltconnect-monitor.service
cp "${PROJECT_DIR}/deploy/systemd/voltconnect-monitor.timer" \
  /etc/systemd/system/voltconnect-monitor.timer

systemctl daemon-reload
systemctl enable --now voltconnect-backup.timer voltconnect-monitor.timer

echo "Monitoramento e backup instalados."
echo "Edite ${CONFIG_DIR}/operations.env para configurar o destino externo e alertas."
echo "Execute o primeiro backup: systemctl start voltconnect-backup.service"
