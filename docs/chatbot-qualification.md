# Passo 4 — Chatbot de qualificação

O gateway Baileys agora qualifica novos contatos antes de transferi-los para um
atendente.

## Fluxo

1. O contato escolhe Vivo Móvel, Internet Empresarial, Energia, Aparelhos ou
   Pós-venda.
2. O bot solicita nome do contato, CNPJ, razão social e cidade/UF.
3. Conforme o produto, solicita quantidade de linhas, valor da conta de energia
   ou uma descrição da necessidade.
4. Os dados são gravados nos atributos do contato e da conversa.
5. A conversa recebe a etiqueta do produto e é atribuída à equipe correta.
6. O bot para de responder assim que um agente humano envia uma mensagem.
7. Se a conversa foi iniciada por um agente, o menu não é exibido quando o
   cliente responder.
8. A intervenção humana fica gravada no estado do gateway. Depois disso, nem
   mesmo a palavra `menu` reativa o bot nessa conversa.
9. Quando um agente inicia ou responde uma conversa, ela é automaticamente
   atribuída a esse agente e recebe a marca persistente de atendimento humano.
10. Uma atribuição manual feita no Chatwoot também bloqueia imediatamente o
    menu, mesmo que o agente ainda não tenha enviado uma mensagem pública.

Enquanto nenhum agente tiver participado, o contato pode digitar `menu` para
reiniciar a qualificação e `6` ou `falar com atendente` para solicitar
atendimento humano.

## Dados preenchidos

- CNPJ
- nome do contato
- razão social
- cidade/UF
- produto de interesse
- quantidade de linhas
- valor da conta de energia
- origem do lead
- status e resumo da qualificação

## Ativação

No `.env`:

```env
WHATSAPP_BOT_ENABLED=true
```

Depois, recrie o gateway:

```bash
docker compose up -d --build baileys
```

Para desativar o bot sem remover a integração, altere a variável para `false` e
recrie o gateway.

## Teste recomendado

Use um número que ainda não tenha uma conversa ativa e envie `oi`. Complete
todo o fluxo e confira no Chatwoot:

- painel lateral do contato;
- atributos da conversa;
- etiquetas;
- equipe atribuída.
