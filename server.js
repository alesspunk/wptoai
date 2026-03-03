const path = require("path");
const express = require("express");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);
const isVercel = Boolean(process.env.VERCEL);
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const orderNotificationTo = process.env.ORDER_NOTIFICATION_TO || "alesspunk@gmail.com";
const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
const smtpSecure =
  String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || smtpPort === 465;
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const mailFrom = process.env.SMTP_FROM || "WP to AI <no-reply@wptoai.com>";
const mailer = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    })
  : null;
const processedWebhookEvents = new Set();

const ADDON_PRICES = {
  design_system: { name: "Design System in a Figma File", amount: 200 },
  blog_powerups: { name: "Powerups for Blog Sites", amount: 200 },
  ecommerce_powerups: { name: "Powerups for E-commerce", amount: 300 }
};

app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) {
    return res.status(500).send("Stripe is not configured.");
  }
  if (!stripeWebhookSecret) {
    return res.status(500).send("Webhook secret is not configured.");
  }

  const signature = req.headers["stripe-signature"];
  if (!signature) {
    return res.status(400).send("Missing Stripe signature header.");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (error) {
    console.error("Stripe webhook signature error:", error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (processedWebhookEvents.has(event.id)) {
    return res.json({ received: true, duplicate: true });
  }
  processedWebhookEvents.add(event.id);
  if (processedWebhookEvents.size > 2000) {
    processedWebhookEvents.clear();
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutSessionCompleted(event.data.object);
    }
    return res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook handler error:", error);
    return res.status(500).send("Webhook handler failed.");
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function normalizeInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizePages(value) {
  const pages = normalizeInt(value, 1);
  return Math.min(Math.max(pages, 1), 25);
}

function normalizePrompts(value) {
  const prompts = normalizeInt(value, 20);
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
  if (!match) return "";
  const maybeUrl = match[0];
  return /^https?:\/\//i.test(maybeUrl) ? maybeUrl : `https://${maybeUrl}`;
}

function getQuoteRule(pages) {
  if (pages <= 3) return { label: "1-3 pages", first: 50, next: 40 };
  if (pages <= 6) return { label: "3-6 pages", first: 50, next: 40 };
  return { label: "6+ pages", first: 40, next: 30 };
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
  const websiteUrl = extractUrl(payload.websiteUrl || "");
  const selectedAddons = Array.isArray(payload.selectedAddons)
    ? payload.selectedAddons.filter((id) => Object.prototype.hasOwnProperty.call(ADDON_PRICES, id))
    : [];

  const rule = getQuoteRule(pages);
  const homepageTotal = rule.first;
  const innerCount = Math.max(0, pages - 1);
  const innerTotal = innerCount * rule.next;
  const oneTimeTotal = homepageTotal + innerTotal;

  const includedPrompts = 20;
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
    ruleLabel: rule.label,
    oneTimeTotal,
    maintenanceEnabled,
    maintenanceTotal,
    monthlyTotal,
    addonItems,
    total: oneTimeTotal + monthlyTotal
  };
}

async function sendOrderEmail(session) {
  if (!mailer) {
    console.warn("SMTP is not configured; skipping order email notification.");
    return;
  }
  if (!session || !session.id) return;

  const metadata = session.metadata || {};
  const customerDetails = session.customer_details || {};
  const websiteUrl = metadata.website_url || "Not provided";
  const createdDate = session.created
    ? new Date(session.created * 1000).toISOString()
    : new Date().toISOString();

  let lineItemsText = "";
  try {
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 20 });
    if (lineItems && Array.isArray(lineItems.data) && lineItems.data.length) {
      const lines = lineItems.data.map((item) => {
        const name = item.description || "Item";
        const quantity = item.quantity || 1;
        const amount = formatMoneyFromCents(item.amount_total || 0);
        return `- ${name} x${quantity}: ${amount}`;
      });
      lineItemsText = `\nLine items:\n${lines.join("\n")}`;
    }
  } catch (error) {
    console.error("Could not load line items for order email:", error.message);
  }

  const subject = `New WP to AI order: ${websiteUrl}`;
  const text = [
    "A new Stripe checkout was completed for WP to AI.",
    "",
    `Session ID: ${session.id}`,
    `Created: ${createdDate}`,
    `Website URL: ${websiteUrl}`,
    `Customer email: ${customerDetails.email || session.customer_email || "Not provided"}`,
    `Customer name: ${customerDetails.name || "Not provided"}`,
    `Payment status: ${session.payment_status || "unknown"}`,
    `Checkout mode: ${session.mode || "unknown"}`,
    `One-time total (USD): ${metadata.one_time_usd || "0"}`,
    `Monthly total (USD): ${metadata.monthly_usd || "0"}`,
    `Order amount: ${formatMoneyFromCents(session.amount_total || 0)}`,
    `Pages: ${metadata.pages || "n/a"}`,
    `Pricing tier: ${metadata.pricing_tier || "n/a"}`,
    `AI engineers: ${metadata.engineers || "0"}`,
    `Prompts: ${metadata.prompts || "0"}`,
    `Add-ons: ${metadata.addons || "none"}`,
    lineItemsText
  ]
    .filter(Boolean)
    .join("\n");

  await mailer.sendMail({
    from: mailFrom,
    to: orderNotificationTo,
    subject,
    text
  });
  console.log(`Order notification email sent to ${orderNotificationTo} for ${session.id}`);
}

async function handleCheckoutSessionCompleted(session) {
  await sendOrderEmail(session);
}

app.post("/api/create-checkout-session", async (req, res) => {
  if (!stripe) {
    return res.status(500).json({
      error: "Stripe is not configured. Add STRIPE_SECRET_KEY to your environment."
    });
  }

  try {
    const quote = buildQuote(req.body || {});
    if (!quote.websiteUrl) {
      return res.status(400).json({
        error: "Paste your WordPress URL here and we’ll migrate your site."
      });
    }

    const baseUrl =
      process.env.BASE_URL ||
      `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    const successUrl = `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/?checkout=cancel`;

    const hasRecurring = quote.monthlyTotal > 0;
    const mode = hasRecurring ? "subscription" : "payment";
    const lineItems = [];

    if (quote.oneTimeTotal > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          unit_amount: quote.oneTimeTotal * 100,
          product_data: {
            name: "WP to AI Site Migration (One-time)"
          }
        },
        quantity: 1
      });
    }

    if (quote.maintenanceEnabled && quote.maintenanceTotal > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          recurring: { interval: "month" },
          unit_amount: quote.maintenanceTotal * 100,
          product_data: {
            name: "WP to AI Monthly Payment"
          }
        },
        quantity: 1
      });
    }

    quote.addonItems.forEach((addon) => {
      lineItems.push({
        price_data: {
          currency: "usd",
          recurring: { interval: "month" },
          unit_amount: addon.amount * 100,
          product_data: {
            name: addon.name
          }
        },
        quantity: 1
      });
    });

    const metadata = {
      website_url: quote.websiteUrl.slice(0, 500),
      pages: String(quote.pages),
      pricing_tier: quote.ruleLabel,
      one_time_usd: String(quote.oneTimeTotal),
      monthly_usd: String(quote.monthlyTotal),
      engineers: String(quote.engineers),
      prompts: String(quote.prompts),
      addons: quote.addonItems.length ? quote.addonItems.map((addon) => addon.id).join(",") : "none"
    };

    const params = {
      mode,
      line_items: lineItems,
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata
    };

    if (mode === "subscription") {
      params.subscription_data = { metadata };
    }

    const session = await stripe.checkout.sessions.create(params);
    return res.json({ url: session.url });
  } catch (error) {
    console.error("Stripe checkout error:", error);
    return res.status(500).json({
      error: "Stripe checkout could not start. Please try again."
    });
  }
});

if (!isVercel) {
  app.listen(port, () => {
    console.log(`WP to AI server running on http://localhost:${port}`);
  });
}

module.exports = app;
