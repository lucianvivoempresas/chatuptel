const FACT_FIELDS = [
  ['contactName', 'contactName'],
  ['companyName', 'companyName'],
  ['productKey', 'product'],
  ['productName', 'productName'],
  ['cnpj', 'companyDocument'],
  ['city', 'city'],
  ['lines', 'lines'],
  ['energyValue', 'energyBill'],
  ['energySimulationSummary', 'energySimulation'],
  ['need', 'need'],
];

function compact(value, maxLength = 500) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function factsFromAnswers(answers = {}) {
  const facts = {};
  for (const [source, target] of FACT_FIELDS) {
    const value = compact(answers[source]);
    if (value !== null) facts[target] = value;
  }
  if (answers.energyUnits?.length) {
    facts.energyUnits = answers.energyUnits.slice(0, 20).map(unit => ({
      id: compact(unit.id, 80),
      state: compact(unit.state, 2),
      billTotal: Number(unit.billTotal || 0),
      consumptions: Array.isArray(unit.consumptions) ? unit.consumptions.slice(0, 6).map(Number) : [],
    }));
  }
  return facts;
}

function memorySummary(facts) {
  return [
    facts.contactName && `Contato: ${facts.contactName}`,
    facts.companyName && `Empresa: ${facts.companyName}`,
    facts.productName && `Produto: ${facts.productName}`,
    facts.city && `Cidade/UF: ${facts.city}`,
    facts.lines && `Linhas: ${facts.lines}`,
    facts.energyBill && `Conta: ${facts.energyBill}`,
    facts.energySimulation && `Simulação: ${facts.energySimulation}`,
    facts.need && `Necessidade: ${facts.need}`,
  ].filter(Boolean).join(' | ').slice(0, 2000);
}

export function refreshSdrMemory(bot, now = new Date()) {
  if (!bot) return null;
  const previous = bot.memory || {};
  const facts = factsFromAnswers(bot.answers);
  bot.memory = {
    version: 1,
    stage: compact(bot.stage, 80) || 'product',
    facts,
    summary: memorySummary(facts),
    updatedAt: now.toISOString(),
    aiUsage: {
      calls: Number(previous.aiUsage?.calls || 0),
      promptTokens: Number(previous.aiUsage?.promptTokens || 0),
      completionTokens: Number(previous.aiUsage?.completionTokens || 0),
      estimatedCostUsd: Number(previous.aiUsage?.estimatedCostUsd || 0),
    },
  };
  return bot.memory;
}

export function canUseSdrAi(memory, {
  maxCalls = 12,
  maxTotalTokens = 60000,
  maxEstimatedCostUsd = 0.05,
} = {}) {
  const usage = memory?.aiUsage || {};
  const totalTokens = Number(usage.promptTokens || 0) + Number(usage.completionTokens || 0);
  if (Number(usage.calls || 0) >= maxCalls) return { allowed: false, reason: 'call_limit' };
  if (totalTokens >= maxTotalTokens) return { allowed: false, reason: 'token_limit' };
  if (Number(usage.estimatedCostUsd || 0) >= maxEstimatedCostUsd) return { allowed: false, reason: 'cost_limit' };
  return { allowed: true, reason: null };
}

export function recordSdrAiUsage(memory, usage = {}) {
  memory.aiUsage ||= { calls: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 };
  memory.aiUsage.calls += 1;
  memory.aiUsage.promptTokens += Number(usage.promptTokens || 0);
  memory.aiUsage.completionTokens += Number(usage.completionTokens || 0);
  memory.aiUsage.estimatedCostUsd += Number(usage.estimatedCostUsd || 0);
  return memory.aiUsage;
}

export function sdrMemoryStats(chats = {}) {
  const memories = Object.values(chats).map(chat => chat?.bot?.memory).filter(Boolean);
  return memories.reduce((result, memory) => {
    result.customers += 1;
    result.aiCalls += Number(memory.aiUsage?.calls || 0);
    result.promptTokens += Number(memory.aiUsage?.promptTokens || 0);
    result.completionTokens += Number(memory.aiUsage?.completionTokens || 0);
    result.estimatedCostUsd += Number(memory.aiUsage?.estimatedCostUsd || 0);
    return result;
  }, { customers: 0, aiCalls: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 });
}
