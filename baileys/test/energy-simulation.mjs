import assert from 'node:assert/strict';
import {
  averageConsumption,
  baseDiscountFor,
  estimateEnergyFromMonthlyBill,
  simulateEnergyDiscount,
} from '../src/energy-simulation.js';

assert.equal(baseDiscountFor('BA', 999.99), 12);
assert.equal(baseDiscountFor('BA', 1000), 18);
assert.equal(baseDiscountFor('RN', 3000), 22);
assert.equal(baseDiscountFor('PE', 5000), 30);
assert.equal(baseDiscountFor('BA', 299.99), null);
assert.equal(baseDiscountFor('SP', 1000), null);

assert.deepEqual(estimateEnergyFromMonthlyBill({
  state: 'BA',
  monthlyBill: 10000,
  tariffPerKwh: 1.09,
}), {
  state: 'BA',
  monthlyBill: 10000,
  tariffPerKwh: 1.09,
  estimatedKwh: 9174.31,
  discountRate: 25,
  monthlySavings: 2500,
  annualSavings: 30000,
  estimatedBill: 7500,
});

assert.deepEqual(averageConsumption([812, 958, 1199]), {
  averageKwh: 989.67,
  monthsUsed: 3,
  consumptions: [812, 958, 1199],
});

const example = simulateEnergyDiscount({
  simulatedAt: '2026-08-27T14:00:00-03:00',
  units: [{
    id: 'UC-1',
    state: 'BA',
    consumptions: [812, 958, 1199, 1526, 1471, 1326],
    billTotal: 1207.15,
    publicLighting: 145.58,
    pisRate: 1.22,
    cofinsRate: 5.62,
  }],
});
assert.equal(example.validity.startsAt, '2026-08-27');
assert.equal(example.validity.endsAt, '2026-08-31');
assert.equal(example.groups[0].groupAverageKwh, 1215.33);
assert.equal(example.groups[0].baseDiscountRate, 18);
assert.equal(example.groups[0].units[0].compensableAmount, 1061.57);
assert.equal(example.groups[0].units[0].finalDiscountRate, 24.84);
assert.equal(example.groups[0].units[0].monthlySavings, 263.69);
assert.equal(example.annualSavings, 3164.28);

const multipleStates = simulateEnergyDiscount({
  simulatedAt: '2026-02-10',
  units: [
    { id: 'BA-1', state: 'BA', consumptions: [2500], billTotal: 1000 },
    { id: 'BA-2', state: 'BA', consumptions: [2501], billTotal: 500 },
    { id: 'PE-1', state: 'PE', consumptions: [800], billTotal: 400 },
  ],
});
assert.equal(multipleStates.groups.find(group => group.state === 'BA').baseDiscountRate, 25);
assert.equal(multipleStates.groups.find(group => group.state === 'BA').units[0].finalDiscountRate, 25);
assert.equal(multipleStates.groups.find(group => group.state === 'PE').baseDiscountRate, 18);
assert.equal(multipleStates.validity.endsAt, '2026-02-28');

const withoutTaxes = simulateEnergyDiscount({
  units: [{ state: 'RN', consumptions: [1200], billTotal: 1000, publicLighting: 100 }],
});
assert.equal(withoutTaxes.groups[0].units[0].finalDiscountRate, 18);

const review = simulateEnergyDiscount({
  units: [{ state: 'BA', consumptions: [250], billTotal: 300, hasNis: true }],
});
assert.equal(review.status, 'operator_review');
assert.deepEqual(
  new Set(review.groups[0].reviewReasons),
  new Set(['consumo_abaixo_de_300_kwh', 'tarifa_social_ou_nis']),
);

console.log('energy-simulation: ok');
