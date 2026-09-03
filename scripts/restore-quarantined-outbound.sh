#!/usr/bin/env sh
set -eu

PROJECT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

INTERVAL_SECONDS=${1:-90}
case "$INTERVAL_SECONDS" in
  ''|*[!0-9]*) echo "Erro: informe o intervalo em segundos." >&2; exit 1 ;;
esac
if [ "$INTERVAL_SECONDS" -lt 30 ]; then
  echo "Erro: por segurança, o intervalo mínimo é de 30 segundos." >&2
  exit 1
fi

SUMMARY=$(docker compose run --rm --no-deps baileys node --input-type=module -e '
  import fs from "node:fs";
  const files = fs.readdirSync("/data")
    .filter((name) => name.startsWith("outbound-quarantine-") && name.endsWith(".json"))
    .sort();
  if (!files.length) process.exit(2);
  const file = files.at(-1);
  const quarantine = JSON.parse(fs.readFileSync(`/data/${file}`, "utf8"));
  console.log(`${file}|${(quarantine.jobs || []).length}`);
' 2>/dev/null) || {
  echo "Erro: nenhuma fila em quarentena foi encontrada." >&2
  exit 1
}

QUARANTINE_FILE=${SUMMARY%%|*}
QUARANTINE_COUNT=${SUMMARY##*|}
DURATION_MINUTES=$(( (QUARANTINE_COUNT * INTERVAL_SECONDS + 59) / 60 ))

echo "Arquivo: /data/${QUARANTINE_FILE}"
echo "Mensagens encontradas: ${QUARANTINE_COUNT}"
echo "Intervalo: ${INTERVAL_SECONDS} segundos"
echo "Duração estimada: ${DURATION_MINUTES} minutos"
echo "Mensagens novas continuarão entrando na fila com prioridade normal."
printf 'Agendar o reenvio controlado? [s/N] '
IFS= read -r CONFIRMATION
case "$CONFIRMATION" in
  s|S|sim|SIM|Sim) ;;
  *) echo "Operação cancelada sem alterações."; exit 0 ;;
esac

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
export TIMESTAMP INTERVAL_SECONDS QUARANTINE_FILE

docker compose stop baileys
trap 'docker compose up -d baileys >/dev/null 2>&1 || true' EXIT INT TERM

docker compose run --rm --no-deps \
  -e TIMESTAMP="$TIMESTAMP" \
  -e INTERVAL_SECONDS="$INTERVAL_SECONDS" \
  -e QUARANTINE_FILE="$QUARANTINE_FILE" \
  baileys node --input-type=module -e '
    import fs from "node:fs";
    const statePath = "/data/state.json";
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const quarantine = JSON.parse(
      fs.readFileSync(`/data/${process.env.QUARANTINE_FILE}`, "utf8"),
    );
    const intervalMs = Number(process.env.INTERVAL_SECONDS) * 1000;
    const now = Date.now();
    state.outboundQueue ||= {};
    state.outboundDelivered ||= {};
    fs.copyFileSync(statePath, `/data/state-before-queue-restore-${process.env.TIMESTAMP}.json`);

    let restored = 0;
    let skipped = 0;
    for (const job of quarantine.jobs || []) {
      const key = String(job.key || job.messageId || "");
      if (!key || state.outboundQueue[key] || state.outboundDelivered[key]) {
        skipped += 1;
        continue;
      }
      restored += 1;
      state.outboundQueue[key] = {
        ...job,
        key,
        attempts: 0,
        lastError: "Reenvio controlado de fila recuperada",
        nextAttemptAt: now + restored * intervalMs,
      };
    }

    const temporaryPath = `${statePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
    console.log(`Mensagens agendadas: ${restored}`);
    console.log(`Mensagens já entregues/em fila ignoradas: ${skipped}`);
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
./scripts/baileys-status.sh
echo "Acompanhe com: docker compose logs -f baileys"
