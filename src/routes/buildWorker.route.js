const express = require("express");
const { runNextBuildJobController } = require("../controllers/buildWorker.controller");

const router = express.Router();

router.post("/internal/build-worker/run-next", runNextBuildJobController);

module.exports = router;
