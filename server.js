const path = require("path");
const express = require("express");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
require("dotenv").config();

const quoteRoutes = require("./src/routes/quoteRoutes");
const { createCheckoutRoutes } = require("./src/routes/checkoutRoutes");
const quoteService = require("./src/services/quoteService");
const { formatMoneyFromCents } = require("./src/services/quotePricingService");

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

app.use("/api/quotes", quoteRoutes);
app.use("/api", createCheckoutRoutes({ stripe }));

async function sendOrderEmail(session) {
  if (!mailer) {
    console.warn("SMTP is not configured; skipping order email notification.");
    return;
  }
  if (!session || !session.id || !stripe) return;

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
    `Quote ID: ${metadata.quoteId || "Not provided"}`,
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
    `Deliverables (paid): ${metadata.addons || "none"}`,
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
  const metadata = (session && session.metadata) || {};
  const quoteId = metadata.quoteId;

  if (quoteId) {
    quoteService.markPaidByQuoteId(quoteId, session.id);
  } else if (session && session.id) {
    quoteService.markPaidByStripeSessionId(session.id);
  }

  await sendOrderEmail(session);
}

if (!isVercel) {
  app.listen(port, () => {
    console.log(`WP to AI server running on http://localhost:${port}`);
  });
}

module.exports = app;
