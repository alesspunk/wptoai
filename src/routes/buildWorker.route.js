const express = require("express");
const {
  runNextBuildJobController,
  runNextPreviewPublishController
} = require("../controllers/buildWorker.controller");

const router = express.Router();

router.post("/internal/build-worker/run-next", runNextBuildJobController);
router.post("/internal/preview-publish/run-next", runNextPreviewPublishController);

module.exports = router;
