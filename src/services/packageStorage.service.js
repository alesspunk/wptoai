const { put } = require("@vercel/blob");

function normalizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function buildPackagePrefix(project) {
  const clientId = normalizePathSegment(project && project.userId ? project.userId : "");
  const projectId = normalizePathSegment(project && project.id ? project.id : "") || "project";
  if (clientId) {
    return `client-${clientId}/project-${projectId}/package`;
  }
  return `project-${projectId}/package`;
}

async function uploadProjectPackageBundle(project, packageRecord, validationResult) {
  if (!project || !project.id || !packageRecord || !packageRecord.id) {
    throw new Error("Missing package upload data.");
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Blob storage is not configured. Missing BLOB_READ_WRITE_TOKEN.");
  }

  const prefix = buildPackagePrefix(project);
  const packageKey = `${prefix}/package-bundle.json`;
  const bundlePayload = {
    packageId: packageRecord.id,
    projectId: project.id,
    quoteId: packageRecord.quoteId || null,
    packageVersion: packageRecord.packageVersion,
    schemaVersion: packageRecord.schemaVersion,
    uploadedAt: new Date().toISOString(),
    validation: {
      status: validationResult.validationStatus,
      errors: validationResult.errors,
      warnings: validationResult.warnings
    },
    manifest: packageRecord.manifest || {},
    files: packageRecord.files || {},
    snapshot: packageRecord.snapshot || {}
  };

  console.log("PACKAGE_BLOB_UPLOAD_START", project.id, packageRecord.id, packageKey);

  const result = await put(
    packageKey,
    JSON.stringify(bundlePayload, null, 2),
    {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json"
    }
  );

  const packageUrl = result && result.url ? String(result.url) : "";
  console.log("PACKAGE_BLOB_UPLOAD_OK", project.id, packageRecord.id, packageUrl);

  return {
    packageKey,
    packageUrl,
    storageManifest: {
      provider: "vercel-blob",
      prefix,
      bundlePath: packageKey,
      bundleUrl: packageUrl,
      fileNames: Object.keys(packageRecord.files || {})
    }
  };
}

async function readProjectPackageBundle(packageUrl) {
  const targetUrl = String(packageUrl || "").trim();
  if (!targetUrl) {
    throw new Error("Package URL is missing. The build worker cannot read the package bundle.");
  }

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this runtime.");
  }

  const response = await fetch(targetUrl, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Package bundle fetch failed with status ${response.status}.`);
  }

  const bundle = await response.json();
  if (!bundle || typeof bundle !== "object") {
    throw new Error("Package bundle is empty or invalid.");
  }

  return bundle;
}

module.exports = {
  uploadProjectPackageBundle,
  readProjectPackageBundle
};
