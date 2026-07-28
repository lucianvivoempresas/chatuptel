# Passo 5 — Integração com o EnergiaVolt

A integração envia somente leads cujo produto é **Energia**. Os demais produtos
continuam normalmente no Chatwoot.

## Garantias

- O atendimento não espera o CRM responder.
- A fila pendente fica persistida no volume do Baileys.
- Falhas usam novas tentativas com intervalo crescente.
- CNPJ, telefone e IDs do Chatwoot evitam contatos duplicados.
- O ID da conversa evita oportunidades duplicadas.
- Atualizações não sobrescrevem etapa, vendedor, valor ou observações alterados
  manualmente no EnergiaVolt.
- O EnergiaVolt cria backup antes da escrita.

## Configuração

Depois de atualizar os dois repositórios no servidor:

```bash
cd /opt/voltconect-chat
chmod +x scripts/*.sh
./scripts/configure-energy-crm.sh /caminho/do/crm-server
```

Reinicie os serviços conforme as instruções exibidas pelo script.

## Diagnóstico

```bash
./scripts/crm-sync-status.sh
docker compose logs --since=10m baileys |
  grep -Ei 'EnergiaVolt|sincronizado|sincronização'
```

Quando tudo estiver normal, `configured` será `true` e `pending` será `0`.
