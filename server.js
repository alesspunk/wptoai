const path = require("path");
const express = require("express");
const Stripe = require("stripe");
require("dotenv").config();

const quoteRoutes = require("./src/routes/quoteRoutes");
const { createCheckoutRoutes } = require("./src/routes/checkoutRoutes");
const quoteService = require("./src/services/quoteService");
const { formatMoneyFromCents } = require("./src/services/quotePricingService");
const {
  sendOrderSummary,
  getOrderNotificationRecipient
} = require("./src/services/email.service");

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);
const isVercel = Boolean(process.env.VERCEL);
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const processedWebhookEvents = new Set();

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

app.post("/api/debug-email", async (_req, res) => {
  console.log("SMTP_HOST", process.env.SMTP_HOST || "");
  console.log("SMTP_PORT", Number(process.env.SMTP_PORT));
  console.log("SMTP_SECURE", process.env.SMTP_SECURE === "true");
  console.log("SMTP_USER", process.env.SMTP_USER || "");

  const adminEmail = getOrderNotificationRecipient();
  if (!adminEmail) {
    return res.status(400).json({
      error: "ORDER_NOTIFICATION_TO is not configured."
    });
  }

  try {
    await sendOrderSummary({
      email: adminEmail,
      siteUrl: "https://wptoai.com",
      plan: "debug",
      total: "$0.00",
      subject: "WPtoAI SMTP debug",
      recipientType: "admin"
    });
    return res.json({ ok: true, sentTo: adminEmail });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : "Unknown email error"
    });
  }
});

app.use("/api/quotes", quoteRoutes);
app.use("/api", createCheckoutRoutes({ stripe }));

function extractCustomerEmailFromSession(session) {
  if (!session || typeof session !== "object") return "";
  const candidates = [
    session.customer_details && session.customer_details.email,
    session.customer_email,
    session.customer && session.customer.email
  ];
  for (const value of candidates) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) return normalized;
  }
  return "";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

async function handleCheckoutSessionCompleted(session) {
  const metadata = (session && session.metadata) || {};
  const quoteId = metadata.quoteId;

  try {
    if (quoteId) {
      quoteService.markPaidByQuoteId(quoteId, session.id);
    } else if (session && session.id) {
      quoteService.markPaidByStripeSessionId(session.id);
    }
  } catch (error) {
    console.error("Stripe quote status update error:", error && error.message ? error.message : error);
  }

  const customerEmail = extractCustomerEmailFromSession(session);
  console.log("CUSTOMER_EMAIL_EXTRACTED:", customerEmail);

  const siteUrl = metadata.siteUrl || metadata.website_url || "Not provided";
  const plan = metadata.plan || metadata.pricing_tier || "Not provided";
  const total = formatMoneyFromCents((session && session.amount_total) || 0);
  const adminEmail = getOrderNotificationRecipient();

  if (!customerEmail) {
    console.warn("CUSTOMER_EMAIL_MISSING");
  } else if (!isValidEmail(customerEmail)) {
    console.error("EMAIL_SEND_CUSTOMER_ERROR", `Invalid customer email: ${customerEmail}`);
  } else {
    console.log("EMAIL_SEND_CUSTOMER_START", customerEmail, quoteId || "");
    try {
      await sendOrderSummary({
        email: customerEmail,
        siteUrl,
        plan,
        total,
        subject: "Your WP to AI migration summary",
        recipientType: "customer"
      });
      console.log("EMAIL_SEND_CUSTOMER_OK", customerEmail, quoteId || "");
    } catch (error) {
      console.error("EMAIL_SEND_CUSTOMER_ERROR", error && error.message ? error.message : error);
    }
  }

  if (!adminEmail) {
    console.error("EMAIL_SEND_ADMIN_ERROR", "ORDER_NOTIFICATION_TO is not configured.");
  } else {
    console.log("EMAIL_SEND_ADMIN_START", adminEmail, quoteId || "");
    try {
      await sendOrderSummary({
        email: adminEmail,
        siteUrl,
        plan,
        total,
        subject: "New WPtoAI order",
        recipientType: "admin"
      });
      console.log("EMAIL_SEND_ADMIN_OK", adminEmail, quoteId || "");
    } catch (error) {
      console.error("EMAIL_SEND_ADMIN_ERROR", error && error.message ? error.message : error);
    }
  }
}

if (!isVercel) {
  app.listen(port, () => {
    console.log(`WP to AI server running on http://localhost:${port}`);
  });
}

module.exports = app;
