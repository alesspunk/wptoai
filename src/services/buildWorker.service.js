const buildJobRepository = require("../repositories/buildJob.repository");
const buildOutputRepository = require("../repositories/buildOutput.repository");
const projectPackageRepository = require("../repositories/projectPackage.repository");
const projectRepository = require("../repositories/project.repository");
const { readProjectPackageBundle } = require("./packageStorage.service");
const { uploadBuildArtifacts } = require("./buildStorage.service");
const {
  validateWorkerPackageBundle,
  createStaticSiteBuildFromPackage
} = require("./aiBuild.service");

function createWorkerError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = Number(statusCode || 500);
  return error;
}

function getPackageLocation(buildJob, packageRecord) {
  const packageUrl = String(
    buildJob && buildJob.packageUrl
      ? buildJob.packageUrl
      : (packageRecord && packageRecord.packageUrl ? packageRecord.packageUrl : "")
  ).trim();
  const packageKey = String(
    buildJob && buildJob.packageKey
      ? buildJob.packageKey
      : (packageRecord && packageRecord.packageKey ? packageRecord.packageKey : "")
  ).trim();

  return {
    packageUrl,
    packageKey
  };
}

function getPackageVersion(packageRecord, manifest) {
  return String(
    packageRecord && packageRecord.packageVersion
      ? packageRecord.packageVersion
      : (manifest && manifest.package_version ? manifest.package_version : "")
  ).trim() || null;
}

function getSchemaVersion(packageRecord, manifest) {
  return String(
    packageRecord && packageRecord.schemaVersion
      ? packageRecord.schemaVersion
      : (manifest && manifest.schema_version ? manifest.schema_version : "")
  ).trim() || null;
}

function buildFailureMessage(error) {
  if (!error) return "The build worker encountered an unknown error.";
  if (error.validation && Array.isArray(error.validation.errors) && error.validation.errors[0]) {
    return String(error.validation.errors[0].message || error.message || "The build package is invalid.");
  }
  return String(error.message || "The build worker encountered an unknown error.");
}

async function persistFailedBuildOutput(buildJob, project, buildLog) {
  return buildOutputRepository.upsertBuildOutput({
    buildJobId: buildJob.id,
    projectId: project && project.id ? project.id : buildJob.projectId,
    quoteId: buildJob.quoteId || (project && project.quoteId ? project.quoteId : null),
    provider: buildJob.provider || "openai",
    status: "build_failed",
    outputKey: null,
    outputUrl: null,
    pageCountBuilt: Number(buildLog && buildLog.pageCountBuilt ? buildLog.pageCountBuilt : 0),
    files: {},
    buildLog: buildLog || {}
  });
}

async function processClaimedBuildJob(buildJob) {
  if (!buildJob || !buildJob.id) {
    return { processed: false, buildJob: null };
  }

  const project = await projectRepository.findProjectById(buildJob.projectId);
  if (!project) {
    const missingProjectMessage = "The build job references a project that no longer exists.";
    await buildJobRepository.markBuildJobFailed(buildJob.id, missingProjectMessage);
    throw createWorkerError(missingProjectMessage, 404);
  }

  const packageRecord = await projectPackageRepository.findProjectPackageByProjectId(project.id);
  const { packageUrl } = getPackageLocation(buildJob, packageRecord);
  if (!packageUrl) {
    const missingPackageMessage = "The stored package bundle URL is missing for this build job.";
    await buildJobRepository.markBuildJobFailed(buildJob.id, missingPackageMessage);
    await projectRepository.markProjectBuildFailed(
      project.id,
      buildJob.id,
      packageRecord && packageRecord.packageVersion ? packageRecord.packageVersion : null,
      packageRecord && packageRecord.schemaVersion ? packageRecord.schemaVersion : null
    );
    throw createWorkerError(missingPackageMessage, 400);
  }

  await projectRepository.markProjectBuildInProgress(
    project.id,
    buildJob.id,
    packageRecord && packageRecord.packageVersion ? packageRecord.packageVersion : null,
    packageRecord && packageRecord.schemaVersion ? packageRecord.schemaVersion : null
  );

  try {
    const bundle = await readProjectPackageBundle(packageUrl);
    const validation = validateWorkerPackageBundle(bundle);

    if (validation.errors.length) {
      const validationError = createWorkerError(validation.errors[0].message, 400);
      validationError.validation = validation;
      throw validationError;
    }

    const buildStartedAt = buildJob.buildStartedAt || new Date().toISOString();
    const buildResult = createStaticSiteBuildFromPackage(validation, {
      project,
      buildJob,
      provider: buildJob.provider || "openai",
      startedAt: buildStartedAt
    });

    const storageResult = await uploadBuildArtifacts(project, buildJob, buildResult);
    const completedAt = new Date().toISOString();
    const finalBuildLog = {
      ...buildResult.buildLog,
      completedAt,
      outputKey: storageResult.outputKey,
      outputUrl: storageResult.outputUrl
    };

    if (buildResult.files["build/build-log.json"]) {
      buildResult.files["build/build-log.json"] = {
        path: "build/build-log.json",
        contentType: "application/json",
        content: JSON.stringify(finalBuildLog, null, 2)
      };
      const refreshedLogUpload = await uploadBuildArtifacts(project, buildJob, {
        files: {
          "build/build-log.json": buildResult.files["build/build-log.json"]
        }
      });
      storageResult.files = {
        ...storageResult.files,
        ...refreshedLogUpload.files
      };
    }

    const buildOutput = await buildOutputRepository.upsertBuildOutput({
      buildJobId: buildJob.id,
      projectId: project.id,
      quoteId: buildJob.quoteId || null,
      provider: buildJob.provider || "openai",
      status: "build_ready_for_publish",
      outputKey: storageResult.outputKey,
      outputUrl: storageResult.outputUrl,
      pageCountBuilt: buildResult.pageCountBuilt,
      files: storageResult.files,
      buildLog: finalBuildLog
    });

    const readyJob = await buildJobRepository.markBuildJobReadyForPublish(
      buildJob.id,
      storageResult.outputKey,
      storageResult.outputUrl
    );

    const updatedProject = await projectRepository.markProjectBuildReadyForPublish(
      project.id,
      buildJob.id,
      getPackageVersion(packageRecord, validation.manifest),
      getSchemaVersion(packageRecord, validation.manifest)
    );

    return {
      processed: true,
      buildJob: readyJob,
      buildOutput,
      project: updatedProject,
      warnings: finalBuildLog.warnings || []
    };
  } catch (error) {
    const failureMessage = buildFailureMessage(error);
    const failedAt = new Date().toISOString();
    const failedLog = {
      jobId: buildJob.id,
      projectId: project.id,
      packageId: packageRecord && packageRecord.id ? packageRecord.id : "",
      startedAt: buildJob.buildStartedAt || failedAt,
      completedAt: failedAt,
      pageCountBuilt: 0,
      warnings: error.validation && Array.isArray(error.validation.warnings)
        ? error.validation.warnings
        : [],
      errors: error.validation && Array.isArray(error.validation.errors)
        ? error.validation.errors
        : [{ code: "build_failed", message: failureMessage }],
      providerUsed: buildJob.provider || "openai",
      outputKey: "",
      outputUrl: ""
    };

    await buildJobRepository.markBuildJobFailed(buildJob.id, failureMessage);
    await persistFailedBuildOutput(buildJob, project, failedLog);
    await projectRepository.markProjectBuildFailed(
      project.id,
      buildJob.id,
      getPackageVersion(packageRecord, error.validation && error.validation.manifest),
      getSchemaVersion(packageRecord, error.validation && error.validation.manifest)
    );

    console.error(
      "BUILD_WORKER_ERROR",
      buildJob.id,
      project.id,
      failureMessage
    );
    throw error;
  }
}

async function runNextBuildJob() {
  const buildJob = await buildJobRepository.claimNextQueuedBuildJob();
  if (!buildJob) {
    return {
      processed: false,
      buildJob: null,
      buildOutput: null,
      project: null
    };
  }

  return processClaimedBuildJob(buildJob);
}

module.exports = {
  processClaimedBuildJob,
  runNextBuildJob
};
