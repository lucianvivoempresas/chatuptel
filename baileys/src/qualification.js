export const PRODUCT_OPTIONS = {
  mobile: {
    name: 'Vivo Móvel',
    label: 'vivo-movel',
    team: 'vendas',
    nextStage: 'lines',
  },
  internet: {
    name: 'Internet Empresarial',
    label: 'internet-empresarial',
    team: 'vendas',
    nextStage: 'need',
  },
  energy: {
    name: 'Energia',
    label: 'energia',
    team: 'energia',
    nextStage: 'energy_invoice',
  },
  devices: {
    name: 'Aparelhos',
    label: 'aparelhos',
    team: 'vendas',
    nextStage: 'need',
  },
  support: {
    name: 'Pós-venda',
    label: 'pos-venda',
    team: 'pos-venda',
    nextStage: 'need',
  },
};

export const MENU_TEXT = `Olá! Sou o *Assistente Uptel Conecta*. 👋

Para direcionar seu atendimento, escolha uma opção:

1 — Vivo Móvel
2 — Internet Empresarial
3 — Energia
4 — Aparelhos
5 — Pós-venda
6 — Falar com um atendente`;

export function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

export function parseProduct(value) {
  const text = normalizeText(value);
  if (text === '1' || /\b(movel|linha|chip|portabilidade)\b/.test(text)) return 'mobile';
  if (text === '2' || /\b(internet|fibra|banda larga)\b/.test(text)) return 'internet';
  if (text === '3' || /\b(energia|conta de luz)\b/.test(text)) return 'energy';
  if (text === '4' || /\b(aparelho|celular|smartphone)\b/.test(text)) return 'devices';
  if (text === '5' || /\b(pos venda|suporte|problema|reclamacao)\b/.test(text)) return 'support';
  if (text === '6' || /\b(atendente|consultor|humano|pessoa)\b/.test(text)) return 'handoff';
  return null;
}

export function formatCnpj(value) {
  const text = normalizeText(value);
  if (/\b(nao tenho|sem cnpj|pessoa fisica)\b/.test(text)) return 'Não informado';
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 14) return null;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

export function parsePositiveInteger(value) {
  const match = String(value || '').match(/\d+/);
  const number = match ? Number(match[0]) : 0;
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function formatCurrency(value) {
  const source = String(value || '').replace(/[^\d,.]/g, '');
  if (!source) return null;
  let normalized = source;
  if (source.includes(',') && source.includes('.')) {
    normalized = source.replace(/\./g, '').replace(',', '.');
  } else if (source.includes(',')) {
    normalized = source.replace(',', '.');
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function isMenuRequest(value) {
  return /\b(menu|inicio|comecar|recomecar)\b/.test(normalizeText(value));
}

export function isEnergyFinalize(value) {
  return /\b(calcular|simular|finalizar|concluir|pronto|terminei|unica|unico)\b/.test(
    normalizeText(value),
  );
}
