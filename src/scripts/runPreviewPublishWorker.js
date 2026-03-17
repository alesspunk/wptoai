require("dotenv").config();

const { runNextPreviewPublishJob } = require("../services/previewPublish.service");

runNextPreviewPublishJob()
  .then((result) => {
    if (!result || !result.processed) {
      console.log("PREVIEW_PUBLISH_WORKER_IDLE");
      process.exit(0);
      return;
    }

    console.log(
      "PREVIEW_PUBLISH_WORKER_OK",
      result.buildJob && result.buildJob.id ? result.buildJob.id : "n/a",
      result.buildOutput && result.buildOutput.previewUrl ? result.buildOutput.previewUrl : "n/a"
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      "PREVIEW_PUBLISH_WORKER_ERROR",
      error && error.message ? error.message : error
    );
    process.exit(1);
  });
