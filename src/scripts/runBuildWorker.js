require("dotenv").config();

const { runNextBuildJob } = require("../services/buildWorker.service");

runNextBuildJob()
  .then((result) => {
    if (!result || !result.processed) {
      console.log("BUILD_WORKER_IDLE");
      process.exit(0);
      return;
    }

    console.log(
      "BUILD_WORKER_OK",
      result.buildJob && result.buildJob.id ? result.buildJob.id : "n/a",
      result.buildOutput && result.buildOutput.outputUrl ? result.buildOutput.outputUrl : "n/a"
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      "BUILD_WORKER_RUN_ERROR",
      error && error.message ? error.message : error
    );
    process.exit(1);
  });
