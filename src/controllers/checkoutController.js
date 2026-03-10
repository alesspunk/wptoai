const quoteService = require("../services/quoteService");
const { createCheckoutSessionForQuote } = require("../services/checkoutService");

function createCheckoutController({ stripe }) {
  return async function createCheckoutSession(req, res) {
    if (!stripe) {
      return res.status(500).json({
        error: "Stripe is not configured. Add STRIPE_SECRET_KEY to your environment."
      });
    }

    const quoteId = String((req.body && req.body.quoteId) || "").trim();
    const email = quoteService.normalizeEmail(req.body && req.body.email);

    if (!quoteId) {
      return res.status(400).json({
        error: "Missing quoteId."
      });
    }

    if (!quoteService.validateEmail(email)) {
      return res.status(400).json({
        error: "Add a valid email to continue checkout."
      });
    }

    const quote = await quoteService.getQuoteById(quoteId);
    if (!quote) {
      return res.status(404).json({
        error: "Quote not found."
      });
    }

    try {
      const baseUrl =
        process.env.BASE_URL ||
        `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;

      const session = await createCheckoutSessionForQuote({
        stripe,
        quote,
        email,
        baseUrl
      });

      await quoteService.markCheckoutCreated(quote.id, session.id, email);

      return res.json({
        url: session.url
      });
    } catch (error) {
      console.error("Stripe checkout error:", error);
      return res.status(500).json({
        error: "Stripe checkout could not start. Please try again."
      });
    }
  };
}

module.exports = {
  createCheckoutController
};
