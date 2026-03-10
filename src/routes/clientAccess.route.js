const express = require("express");
const {
  createClientSuccessController,
  createClientAreaController
} = require("../controllers/clientAccess.controller");

function createClientAccessRoutes({ stripe, appRoot }) {
  const router = express.Router();

  router.get("/client-success", createClientSuccessController({ stripe }));
  router.get("/client-area", createClientAreaController({ appRoot }));

  return router;
}

module.exports = {
  createClientAccessRoutes
};
