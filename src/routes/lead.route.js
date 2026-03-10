const express = require('express');
const { captureLeadController } = require('../controllers/lead.controller');

const router = express.Router();

router.post('/lead-capture', captureLeadController);

module.exports = router;
