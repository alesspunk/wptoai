const { createDraftQuote } = require("../models/quoteModel");
const quoteRepository = require("../repositories/quoteRepository");
const { buildQuote } = require("./quotePricingService");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  return Boolean(email && EMAIL_REGEX.test(email));
}

function toPublicQuote(quote) {
  if (!quote) return null;
  return {
    id: quote.id,
    siteUrl: quote.siteUrl,
    plan: quote.plan,
    addons: quote.addons,
    setupFee: quote.setupFee,
    monthlyFee: quote.monthlyFee,
    currency: quote.currency,
    status: quote.status,
    email: quote.email,
    scanStatus: quote.scanStatus,
    previewImageUrl: quote.previewImageUrl,
    stripeSessionId: quote.stripeSessionId,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt
  };
}

function createQuoteDraft(payload) {
  const quote = buildQuote(payload || {});
  if (!quote.websiteUrl) {
    throw new Error("Paste your WordPress URL here and we’ll migrate your site.");
  }
  if (quote.pages < 1) {
    throw new Error("Add at least 1 page to continue checkout.");
  }

  const email = normalizeEmail(payload && payload.email);
  if (!validateEmail(email)) {
    throw new Error("Add a valid email to continue checkout.");
  }

  const draft = createDraftQuote({
    siteUrl: quote.websiteUrl,
    plan: {
      pages: quote.pages,
      pricingTier: quote.ruleLabel,
      maintenanceEnabled: quote.maintenanceEnabled,
      engineers: quote.engineers,
      prompts: quote.prompts,
      maintenanceFee: quote.maintenanceTotal,
      addonsFee: quote.addonsTotal
    },
    addons: quote.addonItems.map((item) => ({
      id: item.id,
      name: item.name,
      amount: item.amount,
      billingType: "monthly"
    })),
    setupFee: quote.oneTimeTotal,
    monthlyFee: quote.monthlyTotal,
    currency: "usd",
    email
  });

  const stored = quoteRepository.create({
    ...draft,
    quoteBreakdown: {
      oneTimeTotal: quote.oneTimeTotal,
      maintenanceTotal: quote.maintenanceTotal,
      addonsTotal: quote.addonsTotal,
      total: quote.total
    }
  });

  return stored;
}

function getQuoteById(quoteId) {
  return quoteRepository.getById(quoteId);
}

function updateQuoteById(quoteId, patch) {
  return quoteRepository.updateById(quoteId, patch);
}

function markCheckoutCreated(quoteId, stripeSessionId, email) {
  return updateQuoteById(quoteId, {
    status: "checkout_created",
    stripeSessionId: stripeSessionId || null,
    email: normalizeEmail(email)
  });
}

function markPaidByQuoteId(quoteId, stripeSessionId) {
  return updateQuoteById(quoteId, {
    status: "paid",
    stripeSessionId: stripeSessionId || null
  });
}

function markPaidByStripeSessionId(stripeSessionId) {
  const quote = quoteRepository.findByStripeSessionId(stripeSessionId);
  if (!quote) return null;
  return updateQuoteById(quote.id, { status: "paid" });
}

module.exports = {
  normalizeEmail,
  validateEmail,
  toPublicQuote,
  createQuoteDraft,
  getQuoteById,
  markCheckoutCreated,
  markPaidByQuoteId,
  markPaidByStripeSessionId
};
