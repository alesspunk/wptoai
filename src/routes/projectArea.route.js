const express = require("express");
const {
  getProjectAreaDataController,
  sendProjectAreaPasswordResetController
} = require("../controllers/projectArea.controller");

const router = express.Router();

router.get("/project-area-data", getProjectAreaDataController);
router.post("/project-area-password-reset", sendProjectAreaPasswordResetController);

module.exports = router;
