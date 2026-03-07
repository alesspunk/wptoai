const quoteService = require("../services/quoteService");

function createQuote(req, res) {
  try {
    const draft = quoteService.createQuoteDraft(req.body || {});
    return res.status(201).json({
      quote: quoteService.toPublicQuote(draft)
    });
  } catch (error) {
    return res.status(400).json({
      error: error.message || "Could not create quote draft."
    });
  }
}

function getQuote(req, res) {
  const quote = quoteService.getQuoteById(req.params.id);
  if (!quote) {
    return res.status(404).json({
      error: "Quote not found."
    });
  }

  return res.json({
    quote: quoteService.toPublicQuote(quote)
  });
}

module.exports = {
  createQuote,
  getQuote
};
