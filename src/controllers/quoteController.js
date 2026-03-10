const quoteService = require("../services/quoteService");

async function createQuote(req, res) {
  try {
    const draft = await quoteService.createQuoteDraft(req.body || {});
    return res.status(201).json({
      quote: quoteService.toPublicQuote(draft)
    });
  } catch (error) {
    return res.status(400).json({
      error: error.message || "Could not create quote draft."
    });
  }
}

async function getQuote(req, res) {
  try {
    const quote = await quoteService.getQuoteById(req.params.id);
    if (!quote) {
      return res.status(404).json({
        error: "Quote not found."
      });
    }

    return res.json({
      quote: quoteService.toPublicQuote(quote)
    });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : "Could not fetch quote."
    });
  }
}

module.exports = {
  createQuote,
  getQuote
};
