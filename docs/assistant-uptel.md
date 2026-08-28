# Assistente Uptel

O Assistente Uptel é um copiloto interno integrado à tela de conversas do
Chatwoot Community. Por padrão ele usa diretamente a API da OpenAI com o modelo
`gpt-5.6-luna`. A integração antiga com a Zyloo permanece apenas como opção de
compatibilidade.

Ele não é o Captain oficial do Chatwoot e não libera recursos Enterprise. O
componente foi desenvolvido separadamente para a Uptel Conecta.

## Comportamento seguro e econômico

- a análise só começa quando o atendente clica em **Analisar conversa**;
- nenhuma resposta é enviada automaticamente;
- **Inserir no campo** apenas preenche o editor do Chatwoot;
- o atendente ainda precisa revisar e clicar em **Enviar**;
- notas privadas não são encaminhadas ao modelo;
- somente as 6 mensagens textuais mais recentes, limitadas a 800 caracteres
  cada, são usadas;
- fatos comerciais estruturados sobrevivem sem reenviar todo o histórico;
- a busca local envia no máximo 3 trechos relevantes e 3.500 caracteres;
- a resposta do modelo é limitada a 450 tokens, com raciocínio `low`;
- há teto de 20 chamadas, 80 mil tokens e US$ 0,05 por conversa;
- consumo e custo estimado são persistidos em volume separado;
- a chave permanece no contêiner e nunca chega ao navegador ou ao GitHub;
- o serviço confirma o acesso consultando a conversa pela API do Chatwoot;
- materiais em rascunho, inválidos ou vencidos não entram nas sugestões;
- uma falha da IA ou da base não interfere no Chatwoot, WhatsApp, CRM ou
  leitura de faturas.

## Configuração

O projeto reutiliza a `OPENAI_API_KEY` já configurada no arquivo
`/opt/voltconect-chat/.env`. Não copie a chave para o código ou para o GitHub.

```dotenv
ASSISTANT_AI_PROVIDER=openai
ASSISTANT_AI_BASE_URL=https://api.openai.com/v1
ASSISTANT_AI_MODEL=gpt-5.6-luna
ASSISTANT_AI_MAX_OUTPUT_TOKENS=450
ASSISTANT_AI_REASONING_EFFORT=low
ASSISTANT_MAX_CONTEXT_MESSAGES=6
ASSISTANT_MAX_MESSAGE_CHARS=800
ASSISTANT_KNOWLEDGE_MAX_RESULTS=3
ASSISTANT_KNOWLEDGE_MAX_CHARS=3500
ASSISTANT_MAX_AI_CALLS_PER_CONVERSATION=20
ASSISTANT_MAX_AI_TOKENS_PER_CONVERSATION=80000
ASSISTANT_MAX_AI_COST_USD_PER_CONVERSATION=0.05
```

Se `OPENAI_API_KEY` não estiver disponível e houver uma `ZYLOO_API_KEY`, o
serviço usa a Zyloo em modo de compatibilidade. Isso não é alternância de
créditos durante uma conversa: a escolha é feita quando o contêiner inicia.

## Instalação

```bash
cd /opt/voltconect-chat
git pull --ff-only origin main
docker compose build assistant
docker compose run --rm --no-deps assistant npm test
docker compose up -d --no-deps assistant
```

Atualize o Chatwoot com `Ctrl+F5`, abra uma conversa e clique no botão com
brilho na lateral direita. Essa publicação recria somente o assistente; Rails,
Sidekiq, Baileys, PostgreSQL, Redis e CRM não são reiniciados.

## Diagnóstico

```bash
docker compose ps assistant
docker compose logs --tail=100 assistant
curl -s http://127.0.0.1:3002/health
```

O endpoint saudável responde `status: ok`, `configured: true`,
`provider: openai` e `knowledge.available: true`. O bloco `usage` mostra
chamadas, tokens e custo estimado sem expor o conteúdo das conversas. O endpoint
`/uptel-assistant/api/status` também mostra os limites por conversa.

Uma falha do provedor não interfere no WhatsApp, no Chatwoot ou no CRM: apenas
o painel do assistente fica temporariamente indisponível.

## Remoção do painel

O código do painel é registrado na configuração `DASHBOARD_SCRIPTS`, entre os
marcadores `uptel-assistant:start` e `uptel-assistant:end`. Para desativá-lo sem
apagar conversas, remova esse trecho no Super Admin ou ajuste a configuração
com Rails e pare o contêiner `assistant`.
