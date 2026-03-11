const express = require("express");
const {
  getProjectAreaDataController,
  createProjectAreaPageController,
  deleteProjectAreaPageController,
  processProjectAreaPageController,
  renameProjectAreaPageController,
  saveProjectAreaPageOrderController,
  updateProjectAreaPasswordController,
  sendProjectAreaPasswordResetController,
  requestAccessLinkController,
  requestEmailUpdateController,
  verifyEmailUpdateController
} = require("../controllers/projectArea.controller");

const router = express.Router();

router.get("/project-area-data", getProjectAreaDataController);
router.post("/project-area-page-create", createProjectAreaPageController);
router.post("/project-area-page-delete", deleteProjectAreaPageController);
router.post("/project-area-page-scan", processProjectAreaPageController);
router.post("/project-area-page-order", saveProjectAreaPageOrderController);
router.post("/project-area-page-rename", renameProjectAreaPageController);
router.post("/project-area-password", updateProjectAreaPasswordController);
router.post("/project-area-password-reset", sendProjectAreaPasswordResetController);
router.post("/request-access-link", requestAccessLinkController);
router.post("/request-email-update", requestEmailUpdateController);
router.get("/verify-email-update", verifyEmailUpdateController);

module.exports = router;
