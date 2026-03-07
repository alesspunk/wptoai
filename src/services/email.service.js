const nodemailer = require("nodemailer");

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT);
const smtpSecure = process.env.SMTP_SECURE === "true";
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const mailFrom = process.env.SMTP_FROM || "WP to AI <no-reply@wptoai.com>";
const orderNotificationTo = process.env.ORDER_NOTIFICATION_TO || "alesspunk@gmail.com";

let transporter = null;

function hasSmtpConfig() {
  return Boolean(smtpHost && smtpUser && smtpPass);
}

function getTransporter() {
  if (!hasSmtpConfig()) return null;
  if (!transporter) {
    try {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    } catch (error) {
      console.error("SMTP_INIT_ERROR", error && error.message ? error.message : error);
      transporter = null;
    }
  }
  return transporter;
}

async function verifyTransporterConnection() {
  const instance = getTransporter();
  if (!instance) {
    console.error("SMTP_INIT_ERROR", "SMTP is not configured.");
    return false;
  }

  try {
    await instance.verify();
    return true;
  } catch (error) {
    // Do not block subsequent send attempts if verify fails.
    console.error("SMTP_VERIFY_ERROR", error && error.message ? error.message : error);
    return false;
  }
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

  const instance = getTransporter();
  if (!instance) {
    throw new Error("SMTP transporter is not configured.");
  }

  // Validation is best-effort; do not block send if this fails.
  await verifyTransporterConnection();

  const resolvedSubject = subject || "Your WP to AI migration summary";
  const text = buildSummaryText({ siteUrl, plan, total, recipientType });

  try {
    await instance.sendMail({
      from: mailFrom,
      to,
      subject: resolvedSubject,
      text
    });
  } catch (error) {
    throw new Error(error && error.message ? error.message : "Failed to send email.");
  }
}

function getOrderNotificationRecipient() {
  return normalizeRecipient(orderNotificationTo);
}

module.exports = {
  sendOrderSummary,
  getOrderNotificationRecipient,
  verifyTransporterConnection
};
