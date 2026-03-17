const buildWorkerService = require("../services/buildWorker.service");
const previewPublishService = require("../services/previewPublish.service");

function getWorkerTokenFromRequest(req) {
  const headerToken = String(req.headers["x-worker-token"] || "").trim();
  if (headerToken) return headerToken;

  const authHeader = String(req.headers.authorization || "").trim();
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match && match[1] ? String(match[1]).trim() : "";
}

function isAuthorizedWorkerRequest(req) {
  const configuredToken = String(process.env.INTERNAL_BUILD_WORKER_TOKEN || "").trim();
  if (!configuredToken) return false;
  return getWorkerTokenFromRequest(req) === configuredToken;
}

async function runNextBuildJobController(req, res) {
  if (!isAuthorizedWorkerRequest(req)) {
    return res.status(401).json({
      error: "Unauthorized worker request."
    });
  }

  try {
    const result = await buildWorkerService.runNextBuildJob();
    if (!result.processed) {
      return res.json({
        ok: true,
        processed: false
      });
    }

    return res.json({
      ok: true,
      processed: true,
      buildJob: result.buildJob ? {
        id: result.buildJob.id,
        projectId: result.buildJob.projectId,
        status: result.buildJob.status,
        provider: result.buildJob.provider,
        target: result.buildJob.target,
        outputUrl: result.buildJob.buildOutputUrl || null
      } : null,
      buildOutput: result.buildOutput ? {
        id: result.buildOutput.id,
        status: result.buildOutput.status,
        pageCountBuilt: result.buildOutput.pageCountBuilt,
        outputKey: result.buildOutput.outputKey,
        outputUrl: result.buildOutput.outputUrl
      } : null
    });
  } catch (error) {
    const statusCode = Number(error && error.statusCode ? error.statusCode : 500);
    return res.status(statusCode).json({
      error: error && error.message ? error.message : "Build worker execution failed."
    });
  }
}

async function runNextPreviewPublishController(req, res) {
  if (!isAuthorizedWorkerRequest(req)) {
    return res.status(401).json({
      error: "Unauthorized worker request."
    });
  }

  try {
    const result = await previewPublishService.runNextPreviewPublishJob();
    if (!result.processed) {
      return res.json({
        ok: true,
        processed: false
      });
    }

    return res.json({
      ok: true,
      processed: true,
      buildJob: result.buildJob ? {
        id: result.buildJob.id,
        projectId: result.buildJob.projectId,
        status: result.buildJob.status
      } : null,
      buildOutput: result.buildOutput ? {
        id: result.buildOutput.id,
        status: result.buildOutput.status,
        previewUrl: result.buildOutput.previewUrl || null,
        deploymentId: result.buildOutput.deploymentId || null,
        repositoryUrl: result.buildOutput.repositoryUrl || null,
        repositoryName: result.buildOutput.repositoryName || null,
        vercelProjectId: result.buildOutput.vercelProjectId || null,
        publishedAt: result.buildOutput.publishedAt || null
      } : null
    });
  } catch (error) {
    const statusCode = Number(error && error.statusCode ? error.statusCode : 500);
    return res.status(statusCode).json({
      error: error && error.message ? error.message : "Preview publish worker execution failed."
    });
  }
}

module.exports = {
  runNextBuildJobController,
  runNextPreviewPublishController
};
