const crypto = require("crypto");

function generateQuoteId() {
  if (typeof crypto.randomUUID === "function") {
    return `quote_${crypto.randomUUID()}`;
  }
  return `quote_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createDraftQuote(input) {
  const now = new Date().toISOString();

  return {
    id: generateQuoteId(),
    siteUrl: input.siteUrl,
    plan: input.plan,
    addons: input.addons,
    setupFee: input.setupFee,
    monthlyFee: input.monthlyFee,
    currency: input.currency || "usd",
    status: "draft",
    email: input.email || "",
    scanStatus: "pending",
    previewImageUrl: null,
    detectedPagesData: [],
    stripeSessionId: null,
    createdAt: now,
    updatedAt: now
  };
}

module.exports = {
  createDraftQuote
};
