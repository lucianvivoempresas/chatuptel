import assert from 'node:assert/strict';
import {
  formatCnpj,
  formatCurrency,
  isEnergyFinalize,
  isMenuRequest,
  parsePositiveInteger,
  parseProduct,
} from '../src/qualification.js';

assert.equal(parseProduct('1'), 'mobile');
assert.equal(parseProduct('Quero internet fibra'), 'internet');
assert.equal(parseProduct('conta de luz'), 'energy');
assert.equal(parseProduct('falar com atendente'), 'handoff');
assert.equal(formatCnpj('12.345.678/0001-90'), '12.345.678/0001-90');
assert.equal(formatCnpj('123'), null);
assert.equal(formatCnpj('não tenho'), 'Não informado');
assert.equal(parsePositiveInteger('Quero 12 linhas'), 12);
assert.equal(parsePositiveInteger('nenhuma'), null);
assert.equal(formatCurrency('R$ 1.250,50'), 'R$ 1.250,50');
assert.equal(isMenuRequest('voltar ao menu'), true);
assert.equal(isEnergyFinalize('Pode calcular agora'), true);
assert.equal(isEnergyFinalize('vou enviar outra'), false);

console.log('qualification: ok');
