const { createDraftQuote } = require("../models/quoteModel");
const quoteRepository = require("../repositories/quote.repository");
const leadRepository = require("../repositories/lead.repository");
const { buildQuote, normalizePages } = require("./quotePricingService");

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
    detectedPages: quote.detectedPages,
    detectedPagesData: Array.isArray(quote.detectedPagesData) ? quote.detectedPagesData : [],
    siteTitle: quote.siteTitle,
    siteDescription: quote.siteDescription,
    stripeSessionId: quote.stripeSessionId,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt
  };
}

async function createQuoteDraft(payload) {
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

  const stored = await quoteRepository.createQuote(draft);
  await leadRepository.createLead({
    email,
    siteUrl: stored.siteUrl,
    quoteId: stored.id,
    leadStatus: "captured"
  });

  return stored;
}

async function captureLeadAndCreateQuote(payload) {
  const email = normalizeEmail(payload && payload.email);
  if (!validateEmail(email)) {
    throw new Error("Add a valid email to continue.");
  }

  const normalizedPayload = {
    ...(payload || {}),
    email,
    pages: Math.max(1, normalizePages((payload && payload.pages) || 1)),
    maintenanceEnabled: Boolean(payload && payload.maintenanceEnabled),
    engineers: (payload && payload.engineers) || 0,
    prompts: (payload && payload.prompts) || 15,
    selectedAddons: Array.isArray(payload && payload.selectedAddons) ? payload.selectedAddons : []
  };

  const quote = await createQuoteDraft(normalizedPayload);
  return { quoteId: quote.id, quote };
}

async function getQuoteById(quoteId) {
  return quoteRepository.findQuoteById(quoteId);
}

async function markCheckoutCreated(quoteId, stripeSessionId, email) {
  const updated = await quoteRepository.updateQuoteStatus(quoteId, {
    status: "checkout_started",
    stripeSessionId: stripeSessionId || null,
    email: normalizeEmail(email)
  });

  await leadRepository.updateLeadStatusByQuoteId(quoteId, "checkout_started");
  return updated;
}

async function markPaidByQuoteId(quoteId, stripeSessionId) {
  return quoteRepository.updateQuoteStatus(quoteId, {
    status: "paid",
    stripeSessionId: stripeSessionId || null
  });
}

async function markPaidByStripeSessionId(stripeSessionId) {
  const quote = await quoteRepository.findQuoteByStripeSessionId(stripeSessionId);
  if (!quote) return null;
  return quoteRepository.updateQuoteStatus(quote.id, {
    status: "paid"
  });
}

async function markLeadPaidByQuoteId(quoteId) {
  return leadRepository.updateLeadStatusByQuoteId(quoteId, "paid");
}

async function updateQuoteScanById(quoteId, scanPatch) {
  return quoteRepository.updateQuoteScan(quoteId, scanPatch || {});
}

async function updateLatestQuoteScanBySiteUrl(siteUrl, scanPatch) {
  const quote = await quoteRepository.findLatestQuoteBySiteUrl(siteUrl);
  if (!quote) return null;
  return quoteRepository.updateQuoteScan(quote.id, scanPatch || {});
}

module.exports = {
  normalizeEmail,
  validateEmail,
  toPublicQuote,
  createQuoteDraft,
  captureLeadAndCreateQuote,
  getQuoteById,
  markCheckoutCreated,
  markPaidByQuoteId,
  markPaidByStripeSessionId,
  markLeadPaidByQuoteId,
  updateQuoteScanById,
  updateLatestQuoteScanBySiteUrl
};
