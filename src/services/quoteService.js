const { createDraftQuote } = require("../models/quoteModel");
const quoteRepository = require("../repositories/quote.repository");
const precheckoutScanRepository = require("../repositories/precheckoutScan.repository");
const leadRepository = require("../repositories/lead.repository");
const { buildQuote, normalizePages, extractUrl } = require("./quotePricingService");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRECHECKOUT_SCAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  return Boolean(email && EMAIL_REGEX.test(email));
}

function normalizeSiteUrlKey(value) {
  const normalizedUrl = extractUrl(String(value || "").trim());
  if (!normalizedUrl) return "";

  try {
    const parsed = new URL(normalizedUrl);
    const pathname = String(parsed.pathname || "/").replace(/\/+$/, "") || "/";
    return `${String(parsed.hostname || "").toLowerCase()}${pathname}`;
  } catch (_error) {
    return normalizedUrl.toLowerCase();
  }
}

function hasHomepageStructuredData(detectedPagesData) {
  if (!Array.isArray(detectedPagesData)) return false;

  return detectedPagesData.some((page) => {
    if (String(page && page.type ? page.type : "").toLowerCase() !== "homepage") {
      return false;
    }
    const structuredData = page && page.structuredData;
    return Boolean(
      structuredData &&
      typeof structuredData === "object" &&
      !Array.isArray(structuredData) &&
      Object.keys(structuredData).length
    );
  });
}

function buildScanPatch(scanSource) {
  if (!scanSource || typeof scanSource !== "object") return null;

  const detectedPagesData = Array.isArray(scanSource.detectedPagesData)
    ? scanSource.detectedPagesData
    : [];
  const detectedPages = Number.isFinite(Number(scanSource.detectedPages))
    ? Number(scanSource.detectedPages)
    : (detectedPagesData.length || 0);
  const scanStatus = String(scanSource.scanStatus || "").trim().toLowerCase();
  const patch = {
    scanStatus: scanStatus || "pending",
    previewImageUrl: String(scanSource.previewImageUrl || "").trim(),
    detectedPages,
    detectedPagesData,
    siteTitle: String(scanSource.siteTitle || "").trim(),
    siteDescription: String(scanSource.siteDescription || "").trim()
  };

  if (
    patch.scanStatus !== "completed" &&
    !patch.previewImageUrl &&
    !patch.siteTitle &&
    !patch.siteDescription &&
    !(patch.detectedPages > 0) &&
    !patch.detectedPagesData.length
  ) {
    return null;
  }

  return patch;
}

function isRecentPrecheckoutScan(scanRecord) {
  if (!scanRecord || !scanRecord.updatedAt) return false;
  const updatedAtMs = new Date(scanRecord.updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) return false;
  return (Date.now() - updatedAtMs) <= PRECHECKOUT_SCAN_MAX_AGE_MS;
}

function shouldCopyScanPatchToQuote(quote, scanPatch) {
  if (!quote || !scanPatch) return false;

  const quoteHasStructuredData = hasHomepageStructuredData(quote.detectedPagesData);
  const patchHasStructuredData = hasHomepageStructuredData(scanPatch.detectedPagesData);
  if (patchHasStructuredData && !quoteHasStructuredData) return true;

  if (!Array.isArray(quote.detectedPagesData) || !quote.detectedPagesData.length) {
    if (Array.isArray(scanPatch.detectedPagesData) && scanPatch.detectedPagesData.length) {
      return true;
    }
  }

  if (!String(quote.previewImageUrl || "").trim() && scanPatch.previewImageUrl) return true;
  if (!String(quote.siteTitle || "").trim() && scanPatch.siteTitle) return true;
  if (!String(quote.siteDescription || "").trim() && scanPatch.siteDescription) return true;
  if (!(Number(quote.detectedPages) > 0) && scanPatch.detectedPages > 0) return true;
  if (String(quote.scanStatus || "").trim().toLowerCase() !== "completed" && scanPatch.scanStatus === "completed") {
    return true;
  }

  return false;
}

async function storeDeferredPrecheckoutScan(siteUrl, scanPatch) {
  const patch = buildScanPatch(scanPatch);
  const siteKey = normalizeSiteUrlKey(siteUrl);
  const normalizedSiteUrl = extractUrl(siteUrl || "");

  if (!patch || !siteKey || !normalizedSiteUrl) return null;

  return precheckoutScanRepository.upsertPrecheckoutScan({
    siteKey,
    siteUrl: normalizedSiteUrl,
    scanStatus: patch.scanStatus,
    previewImageUrl: patch.previewImageUrl,
    detectedPages: patch.detectedPages,
    detectedPagesData: patch.detectedPagesData,
    siteTitle: patch.siteTitle,
    siteDescription: patch.siteDescription
  });
}

async function attachPrecheckoutScanToQuoteIfMissing(quoteOrId) {
  const quote = typeof quoteOrId === "string"
    ? await quoteRepository.findQuoteById(quoteOrId)
    : quoteOrId;
  if (!quote || !quote.id) return null;

  const siteKey = normalizeSiteUrlKey(quote.siteUrl);
  if (!siteKey) return quote;

  const cachedScan = await precheckoutScanRepository.findPrecheckoutScanBySiteKey(siteKey);
  if (!cachedScan || !isRecentPrecheckoutScan(cachedScan)) {
    return quote;
  }

  const patch = buildScanPatch(cachedScan);
  if (!shouldCopyScanPatchToQuote(quote, patch)) {
    return quote;
  }

  const updatedQuote = await quoteRepository.updateQuoteScan(quote.id, patch);
  if (updatedQuote) {
    console.log("QUOTE_SCAN_DATA_COPIED_FROM_PRECHECKOUT_SCAN", updatedQuote.id, siteKey);
    return updatedQuote;
  }

  return quote;
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
  const quoteWithScan = await attachPrecheckoutScanToQuoteIfMissing(stored);
  await leadRepository.createLead({
    email,
    siteUrl: stored.siteUrl,
    quoteId: stored.id,
    leadStatus: "captured"
  });

  return quoteWithScan || stored;
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
  await attachPrecheckoutScanToQuoteIfMissing(quoteId);
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
  updateLatestQuoteScanBySiteUrl,
  storeDeferredPrecheckoutScan,
  attachPrecheckoutScanToQuoteIfMissing
};
