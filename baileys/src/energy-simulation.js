const DISCOUNT_TABLE = Object.freeze({
  BA: Object.freeze([
    { minKwh: 300, maxKwh: 1000, rate: 12 },
    { minKwh: 1000, maxKwh: 3000, rate: 18 },
    { minKwh: 3000, maxKwh: 5000, rate: 22 },
    { minKwh: 5000, maxKwh: Infinity, rate: 25 },
  ]),
  RN: Object.freeze([
    { minKwh: 300, maxKwh: 1000, rate: 15 },
    { minKwh: 1000, maxKwh: 3000, rate: 18 },
    { minKwh: 3000, maxKwh: 5000, rate: 22 },
    { minKwh: 5000, maxKwh: Infinity, rate: 25 },
  ]),
  PE: Object.freeze([
    { minKwh: 300, maxKwh: 1000, rate: 18 },
    { minKwh: 1000, maxKwh: 3000, rate: 22 },
    { minKwh: 3000, maxKwh: 5000, rate: 25 },
    { minKwh: 5000, maxKwh: Infinity, rate: 30 },
  ]),
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function nonNegative(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function normalizeState(value) {
  return String(value || '').trim().toUpperCase();
}

function simulationPeriod(value = new Date()) {
  const dateOnly = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    : null;
  let year;
  let month;
  let day;
  if (dateOnly) {
    [, year, month, day] = dateOnly.map(Number);
  } else {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Data da simulação inválida');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = type => Number(parts.find(item => item.type === type)?.value);
    year = part('year');
    month = part('month');
    day = part('day');
  }
  const isoDate = (dateYear, dateMonth, dateDay) => [
    dateYear,
    String(dateMonth).padStart(2, '0'),
    String(dateDay).padStart(2, '0'),
  ].join('-');
  if (month < 1 || month > 12) throw new TypeError('Data da simulação inválida');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > lastDay) throw new TypeError('Data da simulação inválida');
  return {
    startsAt: isoDate(year, month, day),
    endsAt: isoDate(year, month, lastDay),
  };
}

export function baseDiscountFor(state, averageKwh) {
  const uf = normalizeState(state);
  const average = finiteNumber(averageKwh);
  if (!DISCOUNT_TABLE[uf] || average === null || average < 300) return null;
  return DISCOUNT_TABLE[uf].find(
    band => average >= band.minKwh && average < band.maxKwh,
  )?.rate ?? null;
}

export function averageConsumption(consumptions) {
  const available = (Array.isArray(consumptions) ? consumptions : [])
    .map(finiteNumber)
    .filter(value => value !== null && value > 0)
    .slice(0, 6);
  if (!available.length) return { averageKwh: null, monthsUsed: 0, consumptions: [] };
  return {
    averageKwh: round(available.reduce((sum, value) => sum + value, 0) / available.length),
    monthsUsed: available.length,
    consumptions: available,
  };
}

export function estimateEnergyFromMonthlyBill({ state, monthlyBill, tariffPerKwh = 1.09 }) {
  const bill = finiteNumber(monthlyBill);
  const tariff = finiteNumber(tariffPerKwh);
  if (bill === null || bill <= 0) throw new TypeError('Valor mensal inválido');
  if (tariff === null || tariff <= 0) throw new TypeError('Tarifa de energia inválida');
  const estimatedKwh = round(bill / tariff);
  const discountRate = baseDiscountFor(state, estimatedKwh);
  const monthlySavings = discountRate === null ? null : round(bill * discountRate / 100);
  return {
    state: normalizeState(state),
    monthlyBill: round(bill),
    tariffPerKwh: round(tariff),
    estimatedKwh,
    discountRate,
    monthlySavings,
    annualSavings: monthlySavings === null ? null : round(monthlySavings * 12),
    estimatedBill: monthlySavings === null ? null : round(bill - monthlySavings),
  };
}

function reviewReason(unit) {
  if (unit.lowIncome || unit.hasNis) return 'tarifa_social_ou_nis';
  if (unit.readable === false) return 'fatura_ilegivel';
  return null;
}

function calculateUnit(unit, baseDiscountRate) {
  const consumption = averageConsumption(unit.consumptions);
  const billTotal = nonNegative(unit.billTotal);
  const publicLighting = nonNegative(unit.publicLighting) ?? 0;
  const compensableAmount = billTotal === null ? null : round(Math.max(0, billTotal - publicLighting));
  const pisRate = nonNegative(unit.pisRate);
  const cofinsRate = nonNegative(unit.cofinsRate);
  const taxDiscountRate = round((pisRate ?? 0) + (cofinsRate ?? 0));
  const finalDiscountRate = baseDiscountRate === null
    ? null
    : round(baseDiscountRate + taxDiscountRate);
  const monthlySavings = compensableAmount === null || finalDiscountRate === null
    ? null
    : round(compensableAmount * finalDiscountRate / 100);

  return {
    id: String(unit.id || unit.name || ''),
    state: normalizeState(unit.state),
    ...consumption,
    billTotal,
    publicLighting,
    compensableAmount,
    baseDiscountRate,
    pisRate,
    cofinsRate,
    taxDiscountRate,
    finalDiscountRate,
    monthlySavings,
    annualSavings: monthlySavings === null ? null : round(monthlySavings * 12),
    estimatedBill: billTotal === null || monthlySavings === null
      ? null
      : round(Math.max(0, billTotal - monthlySavings)),
    reviewReason: reviewReason(unit),
  };
}

export function simulateEnergyDiscount({ units, simulatedAt = new Date() }) {
  if (!Array.isArray(units) || !units.length) {
    throw new TypeError('Informe ao menos uma unidade consumidora');
  }

  const grouped = new Map();
  for (const unit of units) {
    const state = normalizeState(unit.state) || 'NAO_INFORMADO';
    if (!grouped.has(state)) grouped.set(state, []);
    grouped.get(state).push(unit);
  }

  const groups = [...grouped.entries()].map(([state, stateUnits]) => {
    const prepared = stateUnits.map(unit => ({ unit, consumption: averageConsumption(unit.consumptions) }));
    const groupAverageKwh = round(prepared.reduce(
      (sum, item) => sum + (item.consumption.averageKwh ?? 0),
      0,
    ));
    const baseDiscountRate = baseDiscountFor(state, groupAverageKwh);
    const reasons = new Set();
    if (!DISCOUNT_TABLE[state]) reasons.add('uf_fora_da_tabela');
    if (prepared.some(item => item.consumption.monthsUsed === 0)) reasons.add('consumo_nao_identificado');
    if (groupAverageKwh < 300) reasons.add('consumo_abaixo_de_300_kwh');

    const calculatedUnits = stateUnits.map(unit => calculateUnit(unit, baseDiscountRate));
    for (const unit of calculatedUnits) {
      if (unit.reviewReason) reasons.add(unit.reviewReason);
      if (unit.billTotal === null) reasons.add('valor_da_fatura_nao_identificado');
    }

    const monthlySavings = round(calculatedUnits.reduce(
      (sum, unit) => sum + (unit.monthlySavings ?? 0),
      0,
    ));
    return {
      state,
      groupAverageKwh,
      baseDiscountRate,
      status: reasons.size ? 'operator_review' : 'eligible',
      reviewReasons: [...reasons],
      monthlySavings,
      annualSavings: round(monthlySavings * 12),
      units: calculatedUnits,
    };
  });

  const monthlySavings = round(groups.reduce((sum, group) => sum + group.monthlySavings, 0));
  return {
    version: 1,
    validity: simulationPeriod(simulatedAt),
    status: groups.some(group => group.status === 'operator_review')
      ? 'operator_review'
      : 'eligible',
    monthlySavings,
    annualSavings: round(monthlySavings * 12),
    groups,
  };
}

export { DISCOUNT_TABLE };
