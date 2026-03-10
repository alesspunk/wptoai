const quoteService = require('../services/quoteService');

async function captureLeadController(req, res) {
  try {
    const payload = req.body || {};
    const result = await quoteService.captureLeadAndCreateQuote(payload);

    return res.status(201).json({
      quoteId: result.quoteId,
      quote: quoteService.toPublicQuote(result.quote)
    });
  } catch (error) {
    return res.status(400).json({
      error: error && error.message ? error.message : 'Could not capture lead.'
    });
  }
}

module.exports = {
  captureLeadController
};
