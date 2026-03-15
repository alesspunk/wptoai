const { put } = require("@vercel/blob");

function normalizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function buildOutputPrefix(project, buildJob) {
  const clientId = normalizePathSegment(project && project.userId ? project.userId : "");
  const projectId = normalizePathSegment(project && project.id ? project.id : "") || "project";
  const jobId = normalizePathSegment(buildJob && buildJob.id ? buildJob.id : "") || "job";

  if (clientId) {
    return `client-${clientId}/project-${projectId}/build/${jobId}`;
  }

  return `project-${projectId}/build/${jobId}`;
}

async function uploadBuildArtifacts(project, buildJob, buildResult) {
  if (!project || !project.id || !buildJob || !buildJob.id) {
    throw new Error("Missing build artifact upload data.");
  }

  if (!buildResult || !buildResult.files || typeof buildResult.files !== "object") {
    throw new Error("Build result is missing generated files.");
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Blob storage is not configured. Missing BLOB_READ_WRITE_TOKEN.");
  }

  const prefix = buildOutputPrefix(project, buildJob);
  const fileEntries = Object.entries(buildResult.files);
  const uploadedFiles = {};

  for (const [logicalPath, file] of fileEntries) {
    const relativePath = String(logicalPath || "").replace(/^build\/+/, "");
    if (!relativePath) continue;

    const pathname = `${prefix}/${relativePath}`;
    const result = await put(pathname, String(file.content || ""), {
      access: "public",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: file.contentType || "text/plain; charset=utf-8"
    });

    uploadedFiles[logicalPath] = {
      path: pathname,
      url: result && result.url ? String(result.url) : "",
      contentType: file.contentType || "text/plain; charset=utf-8"
    };
  }

  const indexPath = "build/index.html";
  const outputUrl = uploadedFiles[indexPath] ? uploadedFiles[indexPath].url : "";

  return {
    outputKey: prefix,
    outputUrl,
    files: uploadedFiles
  };
}

module.exports = {
  uploadBuildArtifacts
};
