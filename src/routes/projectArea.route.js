const express = require("express");
const {
  getProjectAreaDataController,
  renameProjectAreaPageController,
  saveProjectAreaPageOrderController,
  sendProjectAreaPasswordResetController
} = require("../controllers/projectArea.controller");

const router = express.Router();

router.get("/project-area-data", getProjectAreaDataController);
router.post("/project-area-page-order", saveProjectAreaPageOrderController);
router.post("/project-area-page-rename", renameProjectAreaPageController);
router.post("/project-area-password-reset", sendProjectAreaPasswordResetController);

module.exports = router;
