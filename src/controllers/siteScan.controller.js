const { scanSite } = require("../services/siteScan.service");

async function siteScanController(req, res) {
  const siteUrl = req && req.body ? req.body.siteUrl : "";

  try {
    const result = await scanSite(siteUrl);
    return res.json(result);
  } catch (error) {
    const message = error && error.message ? error.message : "Unknown site scan error";
    const stack = error && error.stack ? error.stack : "";
    console.error("SITE_SCAN_ERROR", message);
    if (stack) {
      console.error("SITE_SCAN_ERROR_STACK", stack);
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
