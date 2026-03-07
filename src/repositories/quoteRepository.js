const quotesById = new Map();

function create(quote) {
  quotesById.set(quote.id, quote);
  return quote;
}

function getById(id) {
  if (!id) return null;
  return quotesById.get(id) || null;
}

function updateById(id, patch) {
  const current = getById(id);
  if (!current) return null;

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  quotesById.set(id, next);
  return next;
}

function findByStripeSessionId(stripeSessionId) {
  if (!stripeSessionId) return null;
  for (const quote of quotesById.values()) {
    if (quote.stripeSessionId === stripeSessionId) {
      return quote;
    }
  }
  return null;
}

module.exports = {
  create,
  getById,
  updateById,
  findByStripeSessionId
};
