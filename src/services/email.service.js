const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const orderNotificationTo = process.env.ORDER_NOTIFICATION_TO || "alesspunk@gmail.com";

async function sendEmail(to, subject, html) {
  const response = await resend.emails.send({
    from: "WPtoAI <hello@wptoai.com>",
    to,
    subject,
    html
  });

  if (response && response.error) {
    const message =
      (response.error && response.error.message) ||
      "Resend returned an unknown error";
    const error = new Error(message);
    error.resend = response.error;
    throw error;
  }

  const emailId = response && response.data ? response.data.id : "";
  console.log("EMAIL_SENT_RESEND", to, emailId);

  return response;
}

function getOrderNotificationRecipient() {
  return String(orderNotificationTo || "").trim();
}

module.exports = {
  sendEmail,
  getOrderNotificationRecipient
};
