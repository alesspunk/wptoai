const express = require("express");
const { createQuote, getQuote } = require("../controllers/quoteController");

const router = express.Router();

router.post("/", createQuote);
router.get("/:id", getQuote);

module.exports = router;
