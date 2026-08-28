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
- o contexto usa memória estruturada e somente as 6 mensagens mais recentes;
- o PDF e o histórico completo não são copiados para a memória do SDR.

## Estrutura

Os materiais ficam em `knowledge/`. Cada Markdown possui metadados:

```yaml
---
id: identificador-unico
title: Nome exibido ao atendente
version: 1.0.0
status: draft
updated_at: 2026-08-28
valid_from: 2026-08-01
valid_until: 2026-08-31
source_period: 2026-08
products: energia
states: BA, RN, PE
tags: desconto, objeção, contratação
---
```

Use `knowledge/_template.md` para novos materiais. Revise o texto e altere o
status para `active` somente depois da aprovação comercial.

`valid_from` e `valid_until` são obrigatórios para materiais mensais. Fora
desse período, o documento é ignorado automaticamente. Se houver dois arquivos
com o mesmo `id`, somente o mais recente é carregado.

## Books mensais da Vivo

Os três books vigentes usam nomes estáveis em `knowledge/vivo/`. A cada mês:

1. revisar os novos PDFs e confirmar o mês indicado nas capas;
2. substituir os três resumos Markdown, sem colocar os PDFs no repositório;
3. atualizar `version`, `updated_at`, `valid_from`, `valid_until` e
   `source_period`;
4. remover qualquer resumo mensal antigo que tenha outro nome;
5. validar a base e publicar somente o serviço do assistente.

Essa política mantém no servidor apenas o conteúdo textual compacto atual. Os
PDFs permanecem fora do servidor e as ofertas vencidas deixam de participar da
busca. Preço, estoque, cobertura e condição por UF continuam sujeitos à
ferramenta comercial vigente.

## Atualização segura

Na primeira instalação desta etapa:

```bash
cd /opt/voltconect-chat
git pull --ff-only origin main
docker compose up -d --build assistant
curl -s http://127.0.0.1:3002/health
```

Antes de publicar uma atualização mensal, valide dentro da mesma imagem usada
em produção:

```bash
docker compose run --rm --no-deps assistant npm run knowledge:validate
docker compose run --rm --no-deps assistant npm test
docker compose up -d --build --no-deps assistant
```

Somente o contêiner `assistant` é recriado. Rails, Sidekiq, Baileys, PostgreSQL,
Redis e CRM não são reiniciados. Em alterações futuras apenas nos arquivos da
base, o serviço recarrega o conteúdo automaticamente em até 30 segundos, sem
reinicialização.

O status saudável deve mostrar `knowledge.available: true`, quantidade de
documentos maior que zero e `errors: []`. O campo `ignored.expired` informa
quantos materiais vencidos foram bloqueados.

## Próxima fase

A memória econômica e os limites do futuro SDR no WhatsApp já estão preparados.
A ativação de respostas autônomas continuará separada e possuirá chave de
desligamento própria; nenhuma resposta autônoma é habilitada nesta etapa.
