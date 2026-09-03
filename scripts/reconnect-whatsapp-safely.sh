#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "Erro: arquivo .env não encontrado em ${PROJECT_DIR}." >&2
  exit 1
fi

STATUS=$(./scripts/baileys-status.sh 2>/dev/null || true)
PENDING=$(printf '%s' "$STATUS" | sed -n 's/.*"pendingOutbound":\([0-9][0-9]*\).*/\1/p')
PENDING=${PENDING:-0}

echo "Sessão atual: $(printf '%s' "$STATUS" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')"
echo "Mensagens que serão colocadas em quarentena: ${PENDING}"
printf 'Continuar com backup, quarentena e novo QR Code? [s/N] '
IFS= read -r CONFIRMATION
case "$CONFIRMATION" in
  s|S|sim|SIM|Sim) ;;
  *) echo "Operação cancelada sem alterações."; exit 0 ;;
esac

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
export TIMESTAMP

docker compose stop baileys
trap 'docker compose up -d baileys >/dev/null 2>&1 || true' EXIT INT TERM

docker compose run --rm --no-deps -e TIMESTAMP="$TIMESTAMP" baileys \
  node --input-type=module -e '
    import fs from "node:fs";
    const statePath = "/data/state.json";
    const timestamp = process.env.TIMESTAMP;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const jobs = Object.values(state.outboundQueue || {});
    fs.copyFileSync(statePath, `/data/state-before-reconnect-${timestamp}.json`);
    fs.writeFileSync(
      `/data/outbound-quarantine-${timestamp}.json`,
      JSON.stringify({ quarantinedAt: new Date().toISOString(), jobs }, null, 2),
      { mode: 0o600 },
    );
    state.outboundQueue = {};
    const temporaryPath = `${statePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
    console.log(`Mensagens preservadas em quarentena: ${jobs.length}`);
  '

docker compose run --rm --no-deps -e TIMESTAMP="$TIMESTAMP" baileys \
  sh -eu -c '
    if [ -d /data/auth ]; then
      mv /data/auth "/data/auth-logged-out-${TIMESTAMP}"
    fi
    mkdir -p /data/auth
    chmod 700 /data/auth
  '

docker compose up -d baileys

ATTEMPT=0
until curl --fail --silent http://127.0.0.1:3001/health >/dev/null 2>&1; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge 30 ]; then
    echo "Erro: o gateway não ficou saudável. Verifique os logs." >&2
    exit 1
  fi
  sleep 2
done

trap - EXIT INT TERM
echo
echo "Backup do estado: /data/state-before-reconnect-${TIMESTAMP}.json"
echo "Fila preservada: /data/outbound-quarantine-${TIMESTAMP}.json"
echo "Sessão anterior: /data/auth-logged-out-${TIMESTAMP}"
echo
./scripts/baileys-qr.sh
