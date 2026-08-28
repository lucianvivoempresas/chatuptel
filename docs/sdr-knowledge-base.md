# Base de Conhecimento do SDR Uptel

A base comercial funciona dentro do serviço independente `assistant`. Ela não
modifica o Chatwoot, o gateway Baileys, o fluxo de faturas ou a integração com
o CRM. Se a base estiver ausente ou inválida, o painel continua disponível e
orienta o atendente a validar informações não encontradas.

## Segurança da primeira etapa

- uso apenas pelo copiloto interno, sempre com aprovação do atendente;
- busca local, sem API de embeddings e sem custo adicional;
- somente trechos relevantes são enviados ao modelo;
- documentos montados como somente leitura no contêiner;
- arquivos com `status: draft` nunca entram nas respostas;
- fontes e versões consultadas aparecem no painel;
- regras comerciais ausentes devem ser encaminhadas para validação humana.

## Estrutura

Os materiais ficam em `knowledge/`. Cada Markdown possui metadados:

```yaml
---
id: identificador-unico
title: Nome exibido ao atendente
version: 1.0.0
status: draft
updated_at: 2026-08-28
products: energia
states: BA, RN, PE
tags: desconto, objeção, contratação
---
```

Use `knowledge/_template.md` para novos materiais. Revise o texto e altere o
status para `active` somente depois da aprovação comercial.

## Atualização segura

Na primeira instalação desta etapa:

```bash
cd /opt/voltconect-chat
git pull --ff-only origin main
docker compose up -d --build assistant
curl -s http://127.0.0.1:3002/health
```

Somente o contêiner `assistant` é recriado. Rails, Sidekiq, Baileys, PostgreSQL,
Redis e CRM não são reiniciados. Em alterações futuras apenas nos arquivos da
base, o serviço recarrega o conteúdo automaticamente em até 30 segundos, sem
reinicialização.

O status saudável deve mostrar `knowledge.available: true`, quantidade de
documentos maior que zero e `errors: []`.

## Próxima fase

Depois da homologação com atendentes, a mesma busca poderá alimentar o SDR no
WhatsApp. Essa ativação será separada e possuirá chave de desligamento própria;
nenhuma resposta autônoma será habilitada nesta etapa.
