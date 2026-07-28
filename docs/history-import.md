# Importação de 30 dias do WhatsApp

O Baileys recebe o histórico durante um novo pareamento por meio do evento
`messaging-history.set`. A quantidade efetivamente entregue é controlada pelo
WhatsApp; portanto, 30 dias é o filtro máximo solicitado pelo projeto, não uma
garantia de que o telefone disponibilizará todas as mensagens e mídias.

## Proteções

- somente conversas individuais são importadas;
- grupos, Status e canais são ignorados;
- mensagens anteriores a 30 dias são ignoradas;
- recebidas e enviadas preservam `external_created_at`;
- IDs já importados ficam registrados e não são duplicados;
- mensagens importadas não acionam chatbot, CRM ou envio de WhatsApp;
- conversas criadas apenas pelo histórico começam resolvidas;
- mídia antiga indisponível é registrada como texto explicativo;
- a sessão anterior é movida para uma pasta de recuperação, não apagada.

## Execução

1. No celular, abra **WhatsApp → Aparelhos conectados** e remova o dispositivo
   antigo do Uptel Conecta.
2. No servidor:

```bash
cd /opt/voltconect-chat
git pull --ff-only origin main
chmod +x scripts/*.sh deploy/*.sh
./scripts/prepare-history-import.sh
```

3. Digite `IMPORTAR` quando solicitado.
4. Quando o gateway disponibilizar o código:

```bash
./scripts/baileys-qr.sh
```

5. Escaneie o QR Code e acompanhe:

```bash
./scripts/history-status.sh
docker compose logs --tail=100 baileys
```

O processo pode demorar conforme o volume e o download de mídias. O campo
`status` torna-se `complete` quando o Baileys sinaliza a conclusão. Confira
também `imported`, `failed` e `updatedAt`.

6. Depois que os números pararem de mudar e o status estiver completo:

```bash
./scripts/finish-history-import.sh
./scripts/baileys-status.sh
```

Isso desativa novos pedidos de histórico sem remover o que já foi importado.
