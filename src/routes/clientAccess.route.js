const express = require("express");
const {
  createClientSuccessController,
  createProjectAreaPageController
} = require("../controllers/clientAccess.controller");

function createClientAccessRoutes({ stripe, appRoot }) {
  const router = express.Router();

  router.get("/client-success", createClientSuccessController({ stripe }));
  router.get("/project-area", createProjectAreaPageController({ appRoot }));
  router.get("/client-area", createProjectAreaPageController({ appRoot }));

  return router;
}

module.exports = {
  createClientAccessRoutes
};
