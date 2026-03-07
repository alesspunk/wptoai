const nodemailer = require("nodemailer");

const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
const smtpSecure =
  String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || smtpPort === 465;
const smtpHost = process.env.SMTP_HOST || "";
const smtpUser = process.env.SMTP_USER || "";
const smtpPass = process.env.SMTP_PASS || "";
const mailFrom = process.env.SMTP_FROM || "WP to AI <no-reply@wptoai.com>";
const orderNotificationTo = process.env.ORDER_NOTIFICATION_TO || "alesspunk@gmail.com";

let transporter = null;
let verifyPromise = null;

function hasSmtpConfig() {
  return Boolean(smtpHost && smtpUser && smtpPass);
}

function getTransporter() {
  if (!hasSmtpConfig()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });
  }
  return transporter;
}

async function verifyTransporterConnection() {
  const instance = getTransporter();
  if (!instance) {
    console.error("EMAIL_ERROR", "SMTP is not configured.");
    return false;
  }

  if (!verifyPromise) {
    verifyPromise = instance
      .verify()
      .then(() => true)
      .catch((error) => {
        verifyPromise = null;
        console.error("EMAIL_ERROR", error && error.message ? error.message : error);
        return false;
      });
  }

  return verifyPromise;
}

function normalizeRecipient(value) {
  return String(value || "").trim();
}

function formatTotal(value) {
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return "$0.00";
  return (value / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD"
  });
}

function buildSummaryText({ siteUrl, plan, total, recipientType }) {
  const heading = recipientType === "admin"
    ? "A new WPtoAI order was completed."
    : "Your WPtoAI migration checkout is complete.";

  return [
    heading,
    "",
    `Site URL: ${siteUrl || "Not provided"}`,
    `Plan: ${plan || "Not provided"}`,
    `Total: ${formatTotal(total)}`
  ].join("\n");
}

async function sendOrderSummary({ email, siteUrl, plan, total, subject, recipientType }) {
  const to = normalizeRecipient(email);
  if (!to) {
    throw new Error("Missing email recipient.");
  }

  const isReady = await verifyTransporterConnection();
  if (!isReady) {
    throw new Error("SMTP transporter is not ready.");
  }

  const instance = getTransporter();
  const resolvedSubject = subject || "Your WP to AI migration summary";
  const text = buildSummaryText({ siteUrl, plan, total, recipientType });

  await instance.sendMail({
    from: mailFrom,
    to,
    subject: resolvedSubject,
    text
  });
}

function getOrderNotificationRecipient() {
  return normalizeRecipient(orderNotificationTo);
}

module.exports = {
  sendOrderSummary,
  getOrderNotificationRecipient,
  verifyTransporterConnection
};
