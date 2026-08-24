# Assistente Uptel

O Assistente Uptel é um copiloto interno integrado à tela de conversas do
Chatwoot Community. Ele usa a API compatível da Zyloo para analisar a conversa
aberta, sugerir uma resposta e responder perguntas internas do atendente.

Ele não é o Captain oficial do Chatwoot e não libera recursos Enterprise. O
componente foi desenvolvido separadamente para a Uptel Conecta.

## Comportamento seguro

- a análise só começa quando o atendente clica em **Analisar conversa**;
- nenhuma resposta é enviada automaticamente;
- **Inserir no campo** apenas preenche o editor do Chatwoot;
- o atendente ainda precisa revisar e clicar em **Enviar**;
- notas privadas não são encaminhadas ao modelo;
- somente as 16 mensagens textuais mais recentes são usadas;
- a chave Zyloo permanece no contêiner e nunca chega ao navegador;
- o serviço confirma o acesso do usuário consultando a conversa pela API do
  próprio Chatwoot;
- há limite de requisições por usuário e conta.

## Instalação

No servidor, adicione a chave ao arquivo `/opt/voltconect-chat/.env`:

```dotenv
ZYLOO_API_KEY=valor-secreto
ZYLOO_BASE_URL=https://api.zyloo.io/v1
ZYLOO_MODEL=zyloo/gpt-4.1
ZYLOO_MAX_TOKENS=700
ASSISTANT_RATE_LIMIT_PER_MINUTE=20
```

O modelo antigo `zyloo/gpt-4.1-free` foi retirado do catálogo. O serviço
consulta `/models` antes da primeira análise, mantém a seleção em cache por 15
minutos e migra automaticamente esse nome antigo para `zyloo/gpt-4.1`. O modelo
substituto pode consumir o saldo ou os créditos promocionais da conta Zyloo.
O limite de 700 tokens controla o custo máximo de cada resposta. Um retorno
HTTP 402 significa que o saldo disponível na carteira Zyloo não é suficiente.

Não envie o `.env` ao GitHub. Depois execute:

```bash
cd /opt/voltconect-chat
git pull --ff-only origin main
chmod +x deploy/install-assistant.sh
sudo ./deploy/install-assistant.sh
```

Atualize o Chatwoot com `Ctrl+F5`, abra uma conversa e clique no botão com
brilho na lateral direita.

Em telas com pelo menos 1180 pixels de largura, o Chatwoot é redimensionado
enquanto o painel estiver aberto, mantendo a conversa e o editor visíveis. Em
telas menores, o painel funciona como uma gaveta sobreposta e pode ser fechado
no botão `×`.

## Diagnóstico

```bash
docker compose ps assistant
docker compose logs --tail=100 assistant
curl -s http://127.0.0.1:3002/health
```

O endpoint saudável responde `status: ok`. `zylooConfigured: false` indica que
a chave não foi carregada; corrija o `.env` e recrie o serviço:

```bash
docker compose up -d --force-recreate assistant
```

Uma falha da Zyloo não interfere no WhatsApp, no Chatwoot ou no CRM: apenas o
painel do assistente fica temporariamente indisponível.

## Remoção do painel

O código do painel é registrado na configuração `DASHBOARD_SCRIPTS`, entre os
marcadores `uptel-assistant:start` e `uptel-assistant:end`. Para desativá-lo sem
apagar conversas, remova esse trecho no Super Admin ou ajuste a configuração
com Rails e pare o contêiner `assistant`.
