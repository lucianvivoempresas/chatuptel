# Segurança e estabilidade

## O que está protegido

- respostas do Chatwoot entram em uma fila persistente antes do envio;
- falhas e desconexões não apagam a resposta: o gateway tenta novamente;
- limites por minuto, destinatário e atendente reduzem abuso e disparos acidentais;
- auditoria registra direção, IDs, atendente, tamanho e hash SHA-256;
- o texto integral das mensagens não é duplicado no log de auditoria;
- os arquivos JSONL de auditoria permanecem 90 dias por padrão;
- backups incluem PostgreSQL, mídias do Chatwoot e sessão/dados do Baileys;
- o pacote de backup é cifrado com AES-256 e uma senha exclusiva do servidor.

## Instalação

No servidor:

```bash
cd /opt/voltconect-chat
git pull --ff-only origin main
chmod +x scripts/*.sh deploy/*.sh
docker compose up -d --build baileys
sudo ./deploy/install-operations.sh
sudo systemctl start voltconnect-backup.service
sudo systemctl status voltconnect-backup.service --no-pager
```

O monitor roda a cada minuto e o backup diariamente às 03:15 no horário de
São Paulo.

Durante a cópia da sessão, o contêiner Baileys é pausado por poucos segundos e
religado automaticamente, inclusive se o backup falhar. O monitor só alerta
uma desconexão após dois minutos, evitando alarmes durante reinicializações
normais.

## Destino externo

Um backup no mesmo VPS não protege contra perda do servidor. Edite:

```bash
sudo nano /etc/voltconnect-chat/operations.env
```

Configure um diretório externo montado:

```dotenv
BACKUP_EXTERNAL_DIR=/mnt/backup-externo/voltconnect-chat
```

ou um remote do `rclone`:

```dotenv
BACKUP_REMOTE=cofre-criptografado:voltconnect-chat
```

O remote `rclone` deve ser preferencialmente do tipo `crypt`. O arquivo já é
cifrado antes do upload, mas o remote criptografado também oculta nomes e
metadados.

Guarde fora do VPS uma cópia segura de
`/root/.config/voltconnect/backup.pass`. Sem essa senha, o backup não pode ser
restaurado.

## Alertas

O monitor sempre registra ocorrências no journal do servidor. Para alertas
remotos, configure no mesmo `operations.env` um webhook ou Telegram:

```dotenv
ALERT_WEBHOOK_URL=
ALERT_TELEGRAM_BOT_TOKEN=
ALERT_TELEGRAM_CHAT_ID=
```

Consulte:

```bash
systemctl list-timers 'voltconnect-*'
journalctl -u voltconnect-monitor.service --since today
journalctl -u voltconnect-backup.service --since today
```

## Auditoria e filas

Os registros ficam dentro do volume persistente do Baileys, em
`/data/audit/messages-AAAA-MM-DD.jsonl`. O status operacional pode ser visto
sem expor a porta na internet:

```bash
TOKEN=$(sed -n 's/^BAILEYS_ADMIN_TOKEN=//p' .env | tail -n 1)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3001/operations/status
```

Os limites padrão são 60 respostas por minuto no número, 10 para o mesmo
destinatário por minuto e 500 por atendente por dia. Podem ser ajustados no
`.env`, mas não devem ser removidos.

## SMTP

O SMTP permanece desativado até existir um provedor. Após preencher as
variáveis `SMTP_*` no `.env`, recrie `rails` e `sidekiq` e envie um teste:

```bash
docker compose up -d --force-recreate rails sidekiq
sh ./scripts/test-smtp.sh
```

## Follow-up do CRM

O lead de Energia cria uma tarefa interna no CRM. Ela exige aprovação humana
e nunca dispara uma mensagem automaticamente. O atendente revisa os dados,
aprova a ação e realiza o contato pelo Chatwoot.
