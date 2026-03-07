const express = require("express");
const { createCheckoutController } = require("../controllers/checkoutController");

function createCheckoutRoutes({ stripe }) {
  const router = express.Router();
  router.post("/create-checkout-session", createCheckoutController({ stripe }));
  return router;
}

module.exports = {
  createCheckoutRoutes
};
