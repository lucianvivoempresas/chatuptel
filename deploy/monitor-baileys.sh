#!/usr/bin/env sh
set -eu
umask 077

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
OPERATIONS_ENV="${OPERATIONS_ENV:-/etc/voltconnect-chat/operations.env}"
STATE_DIR="${MONITOR_STATE_DIR:-/var/lib/voltconnect-chat}"
STATE_FILE="${STATE_DIR}/monitor.state"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"

if [ -f "$OPERATIONS_ENV" ]; then
  # shellcheck disable=SC1090
  . "$OPERATIONS_ENV"
fi

mkdir -p "$STATE_DIR"
TOKEN=$(sed -n 's/^BAILEYS_ADMIN_TOKEN=//p' "${PROJECT_DIR}/.env" | tail -n 1 | tr -d '\r')
TOKEN=$(printf '%s' "$TOKEN" | sed 's/^["'"'"']//;s/["'"'"']$//')

send_alert() {
  message=$1
  logger -t voltconnect-monitor -- "$message"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    escaped=$(printf '%s' "$message" | sed 's/\\/\\\\/g;s/"/\\"/g')
    curl -fsS --max-time 15 -H 'Content-Type: application/json' \
      -d "{\"text\":\"${escaped}\"}" "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  if [ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]; then
    curl -fsS --max-time 15 \
      --data-urlencode "chat_id=${ALERT_TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${message}" \
      "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" >/dev/null || true
  fi
}

NOW=$(date +%s)
BODY=$(curl -fsS --max-time 10 \
  -H "Authorization: Bearer ${TOKEN}" \
  http://127.0.0.1:3001/operations/status 2>/dev/null || printf '{"connection":"unreachable"}')
STATUS=$(printf '%s' "$BODY" | sed -n 's/.*"connection":"\([^"]*\)".*/\1/p')
FAILED=$(printf '%s' "$BODY" | sed -n 's/.*"failedOutbound":\([0-9][0-9]*\).*/\1/p')
STATUS=${STATUS:-unreachable}
FAILED=${FAILED:-0}

PREVIOUS=unknown
LAST_ALERT=0
PREVIOUS_FAILED=0
UNHEALTHY_SINCE=0
DISCONNECT_ALERTED=0
if [ -f "$STATE_FILE" ]; then
  PREVIOUS=$(sed -n '1p' "$STATE_FILE")
  LAST_ALERT=$(sed -n '2p' "$STATE_FILE")
  PREVIOUS_FAILED=$(sed -n '3p' "$STATE_FILE")
  UNHEALTHY_SINCE=$(sed -n '4p' "$STATE_FILE")
  DISCONNECT_ALERTED=$(sed -n '5p' "$STATE_FILE")
fi
UNHEALTHY_SINCE=${UNHEALTHY_SINCE:-0}
DISCONNECT_ALERTED=${DISCONNECT_ALERTED:-0}

if [ "$STATUS" != connected ]; then
  if [ "$PREVIOUS" = connected ] || [ "$UNHEALTHY_SINCE" -eq 0 ]; then
    UNHEALTHY_SINCE=$NOW
  fi
  # connecting/reconnecting durante até dois minutos é uma transição normal.
  if [ $((NOW - UNHEALTHY_SINCE)) -ge 120 ] && \
    { [ "$DISCONNECT_ALERTED" -eq 0 ] || [ $((NOW - LAST_ALERT)) -ge 1800 ]; }; then
    send_alert "ALERTA Uptel Conecta: Baileys está ${STATUS}. Verifique /opt/voltconect-chat."
    LAST_ALERT=$NOW
    DISCONNECT_ALERTED=1
  fi
elif [ "$DISCONNECT_ALERTED" -eq 1 ]; then
  send_alert "RECUPERADO Uptel Conecta: Baileys conectado novamente."
  LAST_ALERT=$NOW
  UNHEALTHY_SINCE=0
  DISCONNECT_ALERTED=0
else
  UNHEALTHY_SINCE=0
fi

if [ "$FAILED" -gt 0 ] && \
  { [ "$FAILED" != "${PREVIOUS_FAILED:-0}" ] || [ $((NOW - LAST_ALERT)) -ge 1800 ]; }; then
  send_alert "ALERTA Uptel Conecta: ${FAILED} mensagem(ns) aguardando nova tentativa de envio."
  LAST_ALERT=$NOW
fi

LATEST_BACKUP=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'voltconnect-chat-*.tar.gz.enc' \
  -printf '%T@\n' 2>/dev/null | sort -n | tail -n 1 | cut -d. -f1)
if [ -z "$LATEST_BACKUP" ] || [ $((NOW - LATEST_BACKUP)) -ge 108000 ]; then
  if [ $((NOW - LAST_ALERT)) -ge 1800 ]; then
    send_alert "ALERTA Uptel Conecta: nenhum backup criptografado recente (últimas 30 horas)."
    LAST_ALERT=$NOW
  fi
fi

printf '%s\n%s\n%s\n%s\n%s\n' \
  "$STATUS" "$LAST_ALERT" "$FAILED" "$UNHEALTHY_SINCE" "$DISCONNECT_ALERTED" \
  > "$STATE_FILE"
printf '%s\n' "$BODY"
