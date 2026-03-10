const ADDON_PRICES = {
  figma_design_system: { name: "Figma Design System", amount: 100 },
  notion_docs: { name: "Notion Docs", amount: 100 },
  storybook_docs: { name: "Storybook Documentation", amount: 100 },
  vercel_deploy: { name: "Vercel Deploy", amount: 100 }
};

function normalizeInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizePages(value) {
  const pages = normalizeInt(value, 0);
  return Math.min(Math.max(pages, 0), 100);
}

function normalizePrompts(value) {
  const prompts = normalizeInt(value, 15);
  return Math.min(Math.max(prompts, 0), 120);
}

function normalizeEngineers(value) {
  const engineers = normalizeInt(value, 0);
  return Math.min(Math.max(engineers, 0), 6);
}

function extractUrl(value) {
  if (!value || typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw) return "";
  const match = raw.match(/https?:\/\/[^\s,]+|www\.[^\s,]+|[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s,]*)?/i);
  const candidate = match ? match[0] : raw;
  const normalized = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;

  try {
    const parsed = new URL(normalized);
    const hostname = String(parsed.hostname || "").toLowerCase();
    if (!hostname || !hostname.includes(".")) return "";
    if (hostname.startsWith(".") || hostname.endsWith(".")) return "";
    const labels = hostname.split(".");
    const tld = labels[labels.length - 1];
    if (!/^[a-z]{2,63}$/i.test(tld)) return "";
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

function getQuoteRule(pages) {
  if (pages <= 3) return { label: "1-3 pages", first: 50, next: 40 };
  if (pages <= 6) return { label: "4-6 pages", first: 45, next: 35 };
  if (pages <= 20) return { label: "7-20 pages", first: 40, next: 30 };
  if (pages <= 50) return { label: "21-50 pages", first: 35, next: 25 };
  return { label: "51-100 pages", first: 30, next: 20 };
}

function formatMoneyFromCents(cents) {
  const normalizedCents = Number.isFinite(cents) ? cents : 0;
  return (normalizedCents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD"
  });
}

function buildQuote(payload) {
  const pages = normalizePages(payload.pages);
  const prompts = normalizePrompts(payload.prompts);
  const maintenanceEnabled = Boolean(payload.maintenanceEnabled);
  const engineers = maintenanceEnabled ? normalizeEngineers(payload.engineers) : 0;
  const websiteUrl = extractUrl(payload.websiteUrl || payload.siteUrl || "");
  const selectedAddons = Array.isArray(payload.selectedAddons)
    ? payload.selectedAddons.filter((id) => Object.prototype.hasOwnProperty.call(ADDON_PRICES, id))
    : [];

  const rule = getQuoteRule(Math.max(pages, 1));
  const homepageTotal = pages > 0 ? rule.first : 0;
  const innerCount = pages > 0 ? Math.max(0, pages - 1) : 0;
  const innerTotal = innerCount * rule.next;
  const oneTimeTotal = homepageTotal + innerTotal;

  const includedPrompts = 15;
  const overagePrompts = Math.max(0, prompts - includedPrompts);
  const maintenanceBase = engineers * 100;
  const maintenanceOverage = overagePrompts * 5;
  const maintenanceTotal = maintenanceEnabled ? maintenanceBase + maintenanceOverage : 0;

  const addonItems = selectedAddons.map((id) => ({
    id,
    name: ADDON_PRICES[id].name,
    amount: ADDON_PRICES[id].amount
  }));
  const addonsTotal = addonItems.reduce((acc, item) => acc + item.amount, 0);
  const monthlyTotal = maintenanceTotal + addonsTotal;

  return {
    websiteUrl,
    pages,
    prompts: maintenanceEnabled ? prompts : 0,
    engineers,
    ruleLabel: pages > 0 ? rule.label : "not_selected",
    oneTimeTotal,
    maintenanceEnabled,
    maintenanceTotal,
    addonsTotal,
    monthlyTotal,
    addonItems,
    total: oneTimeTotal + monthlyTotal
  };
}

module.exports = {
  ADDON_PRICES,
  normalizePages,
  normalizePrompts,
  normalizeEngineers,
  extractUrl,
  getQuoteRule,
  buildQuote,
  formatMoneyFromCents
};
