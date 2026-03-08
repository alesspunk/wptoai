const express = require("express");
const { siteScanController } = require("../controllers/siteScan.controller");

const router = express.Router();

router.post("/site-scan", siteScanController);

module.exports = router;
