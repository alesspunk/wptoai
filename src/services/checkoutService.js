function buildLineItemsFromQuote(quote) {
  const lineItems = [];

  if (quote.setupFee > 0) {
    lineItems.push({
      price_data: {
        currency: quote.currency || "usd",
        unit_amount: Math.round(quote.setupFee * 100),
        product_data: {
          name: "WPtoAI Migration — One-time"
        }
      },
      quantity: 1
    });
  }

  const maintenanceFee = quote.plan && Number.isFinite(quote.plan.maintenanceFee)
    ? quote.plan.maintenanceFee
    : 0;
  if (maintenanceFee > 0) {
    lineItems.push({
      price_data: {
        currency: quote.currency || "usd",
        recurring: { interval: "month" },
        unit_amount: Math.round(maintenanceFee * 100),
        product_data: {
          name: "Site Maintenance — Monthly"
        }
      },
      quantity: 1
    });
  }

  const addonsFee = quote.plan && Number.isFinite(quote.plan.addonsFee)
    ? quote.plan.addonsFee
    : 0;
  if (addonsFee > 0) {
    lineItems.push({
      price_data: {
        currency: quote.currency || "usd",
        recurring: { interval: "month" },
        unit_amount: Math.round(addonsFee * 100),
        product_data: {
          name: "Developer Tools — Monthly"
        }
      },
      quantity: 1
    });
  }

  return lineItems;
}

function buildMetadataFromQuote(quote) {
  const quoteBreakdown = quote.quoteBreakdown || {};
  const siteUrl = String(quote.siteUrl || "").slice(0, 500);
  const quoteId = String(quote.id);
  const email = String(quote.email || "").slice(0, 320);
  return {
    quoteId,
    quote_id: quoteId,
    siteUrl,
    wordpress_url: siteUrl,
    email,
    plan: String((quote.plan && quote.plan.pricingTier) || "not_selected"),
    website_url: siteUrl,
    pages: String((quote.plan && quote.plan.pages) || 0),
    pricing_tier: String((quote.plan && quote.plan.pricingTier) || "not_selected"),
    one_time_usd: String(quote.setupFee || 0),
    maintenance_usd: String((quote.plan && quote.plan.maintenanceFee) || 0),
    addons_usd: String((quote.plan && quote.plan.addonsFee) || 0),
    monthly_usd: String(quote.monthlyFee || 0),
    engineers: String((quote.plan && quote.plan.engineers) || 0),
    prompts: String((quote.plan && quote.plan.prompts) || 0),
    addons: Array.isArray(quote.addons) && quote.addons.length
      ? quote.addons.map((addon) => addon.id).join(",")
      : "none",
    total_usd: String(Number.isFinite(quoteBreakdown.total) ? quoteBreakdown.total : (quote.setupFee || 0) + (quote.monthlyFee || 0))
  };
}

async function createCheckoutSessionForQuote({ stripe, quote, email, baseUrl }) {
  const lineItems = buildLineItemsFromQuote(quote);
  if (!lineItems.length) {
    throw new Error("This quote has no billable items.");
  }

  const hasRecurring = quote.monthlyFee > 0;
  const mode = hasRecurring ? "subscription" : "payment";
  const metadata = buildMetadataFromQuote(quote);

  const params = {
    mode,
    line_items: lineItems,
    allow_promotion_codes: true,
    success_url: `${baseUrl}/client-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?checkout=cancel`,
    customer_email: email,
    metadata
  };

  if (mode === "subscription") {
    params.subscription_data = { metadata };
  }

  return stripe.checkout.sessions.create(params);
}

module.exports = {
  createCheckoutSessionForQuote
};
