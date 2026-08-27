# Simulação de desconto de energia

O cálculo comercial é determinístico. A IA pode extrair dados da fatura e
explicar o resultado, mas não escolhe percentuais nem faz a matemática.

## Regras oficiais

- A média mensal de cada unidade usa até os seis meses mais recentes legíveis.
- Se houver menos de seis meses, a média usa somente a quantidade disponível.
- Unidades são agrupadas por UF. As médias das unidades da mesma UF são somadas.
- O desconto-base do grupo é aplicado a todas as unidades daquele grupo.
- BA: 12% (300–999,99 kWh), 18% (1.000–2.999,99), 22%
  (3.000–4.999,99) e 25% (a partir de 5.000).
- RN: 15%, 18%, 22% e 25% nas mesmas faixas.
- PE: 18%, 22%, 25% e 30% nas mesmas faixas.
- Valor compensável = total da fatura menos iluminação pública.
- Desconto final = desconto-base + alíquota de PIS + alíquota de COFINS, sem teto.
- Quando PIS/COFINS não constarem na fatura, aplica-se somente o desconto-base.
- Economia anual = soma das economias mensais das unidades multiplicada por 12.
- A validade começa na data da simulação e termina no último dia daquele mês.

## Encaminhamento obrigatório ao atendente

A simulação não reprova automaticamente. Ela recebe o status
`operator_review` quando houver:

- média agrupada abaixo de 300 kWh;
- UF fora de BA, RN e PE;
- NIS, Grupo Baixa Renda ou Tarifa Social;
- fatura ilegível;
- consumo ou valor da fatura não identificado.

O arredondamento monetário é feito em centavos. O motor retorna o detalhamento
por UF e por unidade, além da economia mensal e anual consolidadas.

## API interna

O gateway expõe `POST /energy/simulate`, protegido pelo mesmo token administrativo
das demais rotas. Exemplo de corpo:

```json
{
  "simulatedAt": "2026-08-27",
  "units": [
    {
      "id": "UC-1",
      "state": "BA",
      "consumptions": [812, 958, 1199, 1526, 1471, 1326],
      "billTotal": 1207.15,
      "publicLighting": 145.58,
      "pisRate": 1.22,
      "cofinsRate": 5.62,
      "hasNis": false,
      "lowIncome": false,
      "readable": true
    }
  ]
}
```

O endpoint recebe somente dados estruturados. A etapa de leitura de PDF/imagem
deve validar a confiança de cada campo antes de chamar o cálculo.
