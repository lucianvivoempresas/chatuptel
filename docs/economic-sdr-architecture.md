# Arquitetura econômica do SDR

Esta etapa prepara a memória comercial compartilhada pelo fluxo do WhatsApp,
Chatwoot, CRM e Assistente Uptel sem transformar todo o histórico em prompt.

## O que fica persistido

- produto, etapa do lead e próximo passo;
- nome, empresa, cidade e UF quando informados;
- dados estruturados da simulação de energia;
- resumo comercial compacto e utilização acumulada de IA;
- atributos equivalentes já existentes no Chatwoot e no CRM.

Mensagens completas, notas privadas, PDFs e imagens não são duplicados nessa
memória. O Chatwoot continua sendo a fonte do histórico e os anexos seguem sua
política normal de armazenamento.

## Como uma resposta é montada

1. fatos estruturados da memória comercial;
2. até 6 mensagens recentes, com 800 caracteres por mensagem;
3. até 3 trechos locais da base aprovada, totalizando 3.500 caracteres;
4. resposta limitada a 450 tokens.

Perguntas determinísticas, menus, cálculos e leitura já implementada de fatura
continuam usando código local e não gastam tokens do SDR. A IA é reservada para
redação, análise contextual e, numa fase separada, tratamento de objeções.

## Limites

O copiloto interno bloqueia novas chamadas ao atingir qualquer limite por
conversa: 20 chamadas, 80 mil tokens ou US$ 0,05 estimado. O estado fica no
volume `assistant_data` e não se perde quando o contêiner é recriado.

O gateway mantém limites preparados para o futuro SDR autônomo: 12 chamadas,
60 mil tokens ou US$ 0,05 por conversa. A ativação de respostas autônomas ao
cliente continua desligada nesta etapa para não alterar o bot já homologado.

## Provedor

A API direta da OpenAI é o padrão. A OpenRouter pode ser útil para roteamento
entre provedores, mas adiciona taxa na compra de créditos e não reduz o preço
base do mesmo modelo. A Zyloo permanece configurável apenas para compatibilidade.
