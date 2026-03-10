const path = require("path");
const express = require("express");
const Stripe = require("stripe");
require("dotenv").config();

const quoteRoutes = require("./src/routes/quoteRoutes");
const { createCheckoutRoutes } = require("./src/routes/checkoutRoutes");
const siteScanRoutes = require("./src/routes/siteScan.route");
const leadRoutes = require("./src/routes/lead.route");
const projectAreaRoutes = require("./src/routes/projectArea.route");
const { createClientAccessRoutes } = require("./src/routes/clientAccess.route");
const quoteService = require("./src/services/quoteService");
const { formatMoneyFromCents } = require("./src/services/quotePricingService");
const {
  createQueuedProject,
  getProjectByQuoteId,
  ensureProjectAccessToken
} = require("./src/services/project.service");
const userRepository = require("./src/repositories/user.repository");
const { ensureSchema } = require("./src/repositories/postgres");
const {
  sendEmail,
  getOrderNotificationRecipient
} = require("./src/services/email.service");

const app = express();
const port = parseInt(process.env.PORT || "3000", 10);
const isVercel = Boolean(process.env.VERCEL);
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const processedWebhookEvents = new Set();

ensureSchema()
  .then(() => {
    console.log("DATABASE_SCHEMA_READY");
  })
  .catch((error) => {
    console.error("DATABASE_SCHEMA_ERROR", error && error.message ? error.message : error);
  });

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
    return res.json({ received: true, webhookError: true });
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname)));
app.use("/scans", express.static(path.join(__dirname, "public", "scans")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/debug-email", async (_req, res) => {
  const adminEmail = getOrderNotificationRecipient();
  if (!adminEmail) {
    return res.status(400).json({
      error: "ORDER_NOTIFICATION_TO is not configured."
    });
  }

  try {
    await sendEmail(
      adminEmail,
      "WPtoAI email debug",
      "<p>This is a test email from WPtoAI.</p>"
    );
    return res.json({ ok: true, sentTo: adminEmail });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : "Unknown email error"
    });
  }
});

app.use("/api/quotes", quoteRoutes);
app.use("/api", createCheckoutRoutes({ stripe }));
app.use("/api", siteScanRoutes);
app.use("/api", leadRoutes);
app.use("/api", projectAreaRoutes);
app.use("/", createClientAccessRoutes({ stripe, appRoot: __dirname }));

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
  let quoteId = metadata.quote_id || metadata.quoteId || "";
  const wordpressUrl = metadata.wordpress_url || metadata.siteUrl || metadata.website_url || "Not provided";
  const fallbackMetadataEmail = quoteService.normalizeEmail(metadata.email || "");

  try {
    if (quoteId) {
      await quoteService.markPaidByQuoteId(quoteId, session.id);
    } else if (session && session.id) {
      const updatedBySession = await quoteService.markPaidByStripeSessionId(session.id);
      if (updatedBySession && updatedBySession.id) {
        quoteId = String(updatedBySession.id);
      }
    }
  } catch (error) {
    console.error("Stripe quote status update error:", error && error.message ? error.message : error);
  }

  const extractedCustomerEmail = extractCustomerEmailFromSession(session);
  const customerEmail = extractedCustomerEmail || fallbackMetadataEmail;
  console.log("CUSTOMER_EMAIL_EXTRACTED:", customerEmail);
  const normalizedCustomerEmail = quoteService.normalizeEmail(customerEmail || "");

  let user = null;
  if (normalizedCustomerEmail && isValidEmail(normalizedCustomerEmail)) {
    try {
      user = await userRepository.findUserByEmail(normalizedCustomerEmail);
      if (!user) {
        user = await userRepository.createUser(normalizedCustomerEmail);
      }
    } catch (error) {
      console.error("USER_CREATE_OR_FIND_ERROR", error && error.message ? error.message : error);
    }
  }

  if (quoteId) {
    try {
      await quoteService.markLeadPaidByQuoteId(quoteId);
    } catch (error) {
      console.error("LEAD_STATUS_UPDATE_ERROR", error && error.message ? error.message : error);
    }
  }

  let project = null;
  if (quoteId || wordpressUrl !== "Not provided") {
    try {
      if (quoteId) {
        project = await getProjectByQuoteId(quoteId);
      }

      if (!project) {
        project = await createQueuedProject({
          quoteId: quoteId || null,
          userId: user && user.id ? user.id : null,
          customerEmail: normalizedCustomerEmail || null,
          wordpressUrl: wordpressUrl
        });
        console.log("PROJECT_CREATED_QUEUED", quoteId || "n/a");
      }

      project = await ensureProjectAccessToken(project);
    } catch (error) {
      console.error("PROJECT_CREATE_ERROR", error && error.message ? error.message : error);
    }
  }

  const baseUrl = String(process.env.BASE_URL || "https://wptoai.com").replace(/\/+$/, "");
  const projectAccessLink =
    baseUrl && project && project.id && project.accessToken
      ? `${baseUrl}/project-area?project=${encodeURIComponent(project.id)}&token=${encodeURIComponent(project.accessToken)}`
      : "";

  const plan = metadata.plan || metadata.pricing_tier || "Not provided";
  const total = formatMoneyFromCents((session && session.amount_total) || 0);
  const adminEmail = getOrderNotificationRecipient();
  const customerHtml = `
    <p>Hi,</p>
    <p>Your WPtoAI migration checkout is complete.</p>
    <p><strong>Site URL:</strong> ${wordpressUrl}</p>
    <p><strong>Plan:</strong> ${plan}</p>
    <p><strong>Total:</strong> ${total}</p>
    <p>We received your request to convert:</p>
    <p><strong>${wordpressUrl}</strong></p>
    <p>Your project is now being prepared.</p>
    ${
      projectAccessLink
        ? `<p>You can access your Project Area here:</p><p><a href="${projectAccessLink}">${projectAccessLink}</a></p>`
        : `<p>You will soon receive a link where you can manage your site and request changes by chat.</p>`
    }
    <p>— WPtoAI</p>
  `;
  const adminHtml = `
    <p>A new WPtoAI order was completed.</p>
    <p><strong>Site URL:</strong> ${wordpressUrl}</p>
    <p><strong>Plan:</strong> ${plan}</p>
    <p><strong>Total:</strong> ${total}</p>
    <p><strong>Quote ID:</strong> ${quoteId || "n/a"}</p>
  `;

  if (!normalizedCustomerEmail) {
    console.warn("CUSTOMER_EMAIL_MISSING");
  } else if (!isValidEmail(normalizedCustomerEmail)) {
    console.error("EMAIL_SEND_CUSTOMER_ERROR", `Invalid customer email: ${normalizedCustomerEmail}`);
  } else {
    console.log("EMAIL_SEND_CUSTOMER_START", normalizedCustomerEmail, quoteId || "");
    try {
      await sendEmail(normalizedCustomerEmail, "Your WP to AI migration summary", customerHtml);
      console.log("EMAIL_SEND_CUSTOMER_OK", normalizedCustomerEmail, quoteId || "");
    } catch (error) {
      console.error("EMAIL_SEND_FAILED", error && error.message ? error.message : error);
      console.error("EMAIL_SEND_CUSTOMER_ERROR", error && error.message ? error.message : error);
    }
  }

  if (!adminEmail) {
    console.error("EMAIL_SEND_ADMIN_ERROR", "ORDER_NOTIFICATION_TO is not configured.");
  } else {
    console.log("EMAIL_SEND_ADMIN_START", adminEmail, quoteId || "");
    try {
      await sendEmail(adminEmail, "New WPtoAI order", adminHtml);
      console.log("EMAIL_SEND_ADMIN_OK", adminEmail, quoteId || "");
    } catch (error) {
      console.error("EMAIL_SEND_FAILED", error && error.message ? error.message : error);
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
