const { scanSite } = require("../services/siteScan.service");

async function siteScanController(req, res) {
  const siteUrl = req && req.body ? req.body.siteUrl : "";

  try {
    const result = await scanSite(siteUrl);
    return res.json(result);
  } catch (error) {
    console.error("SITE_SCAN_ERROR", error && error.message ? error.message : error);
    return res.json({
      scanStatus: "failed"
    });
  }
}

module.exports = {
  siteScanController
};
