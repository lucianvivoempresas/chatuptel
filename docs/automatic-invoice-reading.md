# Leitura automática de faturas de energia

O Assistente Uptel recebe faturas em PDF, JPG, PNG ou WEBP pelo WhatsApp,
registra o anexo no Chatwoot e envia uma cópia temporária em memória para o
Gemini extrair somente os campos necessários à simulação.

## Configuração

No `.env` do Chatwoot:

```env
GEMINI_API_KEYS=chave-do-projeto-1,chave-do-projeto-2
GEMINI_INVOICE_MODEL=gemini-2.5-flash
ENERGY_INVOICE_MAX_BYTES=15728640
```

Use chaves de projetos diferentes se desejar contingência real. Limites do
Gemini são aplicados por projeto, portanto duas chaves do mesmo projeto
compartilham a mesma cota.

Depois da configuração:

```bash
docker compose up -d --build baileys
./scripts/configure-qualification.sh
./scripts/baileys-status.sh
```

Como alternativa, configure sem exibir a chave no terminal:

```bash
chmod +x scripts/configure-invoice-reading.sh
./scripts/configure-invoice-reading.sh
```

## Fluxo

1. O cliente escolhe Energia e autoriza a análise automatizada.
2. Envia uma fatura por unidade, em PDF ou imagem.
3. O Gemini extrai UF, até seis consumos, total, iluminação pública,
   PIS/COFINS e indicadores de Tarifa Social/NIS.
   Quando o campo principal `TOTAL A PAGAR` estiver zerado, o sistema usa o
   `TOTAL` positivo exibido ao final da tabela de itens/serviços da fatura.
4. O cliente pode enviar outras unidades ou digitar `CALCULAR`.
5. O motor determinístico separa as unidades por UF e calcula a simulação.
6. O resultado é apresentado ao cliente e salvo nos campos do Chatwoot.
7. A fila persistente envia o resultado estruturado ao EnergiaVolt.

Se a leitura automática falhar e o atendimento for transferido para uma pessoa,
o contato e os dados já coletados também são enviados ao CRM como lead parcial.
Uma simulação concluída posteriormente atualiza a mesma oportunidade, identificada
pela conversa do Chatwoot.

## Proteções

- A IA não escolhe descontos e não faz a matemática final.
- Instruções contidas dentro do arquivo são ignoradas.
- Nome, documento e endereço não são solicitados na extração.
- A imagem/PDF não é gravada novamente pelo gateway; o anexo permanece no
  Chatwoot e a análise usa memória temporária.
- Arquivos acima de 15 MB ou de formato não permitido são recusados.
- Leituras com confiança abaixo de 75% pedem uma imagem melhor.
- Após duas leituras ilegíveis, a conversa é encaminhada para uma pessoa.
- Falha de cota/autorização tenta a próxima chave configurada.
- NIS/Tarifa Social, consumo abaixo de 300 kWh e UF fora da tabela nunca são
  reprovados automaticamente: seguem para avaliação humana.
