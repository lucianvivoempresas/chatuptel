---
id: energia-origo-regras
title: Regras de desconto Órigo Energia
version: 1.0.0
status: active
updated_at: 2026-08-28
products: energia
states: BA, RN, PE
tags: desconto, economia, consumo, kwh, fatura, pis, cofins, iluminação pública
---
# Cálculo da média

A média mensal de cada unidade usa até os seis consumos mais recentes disponíveis. Se houver menos de seis meses, calcular pela quantidade disponível. Para várias unidades, separar por estado, calcular a média de cada unidade e somar as médias das unidades do mesmo estado.

# Faixas de desconto-base

- BA: 12% de 300 até 999,99 kWh; 18% de 1.000 até 2.999,99 kWh; 22% de 3.000 até 4.999,99 kWh; 25% a partir de 5.000 kWh.
- RN: 15% de 300 até 999,99 kWh; 18% de 1.000 até 2.999,99 kWh; 22% de 3.000 até 4.999,99 kWh; 25% a partir de 5.000 kWh.
- PE: 18% de 300 até 999,99 kWh; 22% de 1.000 até 2.999,99 kWh; 25% de 3.000 até 4.999,99 kWh; 30% a partir de 5.000 kWh.

O desconto-base obtido pela soma das médias de um estado é aplicado a todas as unidades daquele mesmo estado.

# Economia

Valor compensável é o total da fatura menos a contribuição de iluminação pública. O desconto final é o desconto-base somado às alíquotas de PIS e COFINS exibidas na fatura, sem teto máximo. Se PIS ou COFINS não estiverem informados, aplicar somente os percentuais disponíveis; se nenhum constar, usar apenas o desconto-base.

Economia mensal é o valor compensável multiplicado pelo desconto final. Economia anual é a economia mensal multiplicada por 12. A validade começa na data da simulação e termina no último dia do mesmo mês.

# Simulação parcial

Após falha dos leitores automáticos, pode-se pedir o valor mensal. Estimar o consumo dividindo esse valor por R$ 1,09/kWh e aplicar somente o desconto-base da faixa. Informar claramente que é uma estimativa parcial sujeita à validação do atendente.
