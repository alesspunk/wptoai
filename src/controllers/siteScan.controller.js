const { scanSite } = require("../services/siteScan.service");
const quoteService = require("../services/quoteService");

async function siteScanController(req, res) {
  const body = req && req.body ? req.body : {};
  const siteUrl = body.siteUrl || "";
  const quoteId = body.quoteId ? String(body.quoteId).trim() : "";

  if (quoteId) {
    try {
      await quoteService.updateQuoteScanById(quoteId, { scanStatus: "scanning" });
    } catch (error) {
      console.error("SITE_SCAN_DB_UPDATE_ERROR", error && error.message ? error.message : error);
    }
  }

  try {
    const result = await scanSite(siteUrl);

    try {
      const patch = {
        scanStatus: "completed",
        previewImageUrl: result.previewImageUrl,
        detectedPages: result.detectedPages,
        siteTitle: result.siteTitle,
        siteDescription: result.siteDescription
      };

      if (quoteId) {
        await quoteService.updateQuoteScanById(quoteId, patch);
      } else {
        await quoteService.updateLatestQuoteScanBySiteUrl(result.siteUrl, patch);
      }
    } catch (error) {
      console.error("SITE_SCAN_DB_PERSIST_ERROR", error && error.message ? error.message : error);
    }

    return res.json(result);
  } catch (error) {
    const message = error && error.message ? error.message : "Unknown site scan error";
    const stack = error && error.stack ? error.stack : "";
    console.error("SITE_SCAN_ERROR", message);
    if (stack) {
      console.error("SITE_SCAN_ERROR_STACK", stack);
    }

    if (quoteId) {
      try {
        await quoteService.updateQuoteScanById(quoteId, { scanStatus: "failed" });
      } catch (persistError) {
        console.error("SITE_SCAN_DB_FAILED_STATUS_ERROR", persistError && persistError.message ? persistError.message : persistError);
      }
    }

    return res.status(500).json({
      scanStatus: "failed",
      error: message
    });
  }
}

module.exports = {
  siteScanController
};
