const { put } = require("@vercel/blob");

function normalizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function uploadScreenshotToBlob(projectId, pageId, screenshotBuffer, contentType) {
  if (!projectId || !pageId || !screenshotBuffer) {
    throw new Error("Missing screenshot upload data.");
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("BLOB_STORAGE_TOKEN_MISSING", projectId, pageId);
    throw new Error("Blob storage is not configured. Missing BLOB_READ_WRITE_TOKEN.");
  }

  const normalizedProjectId = normalizePathSegment(projectId) || "project";
  const normalizedPageId = normalizePathSegment(pageId) || "page";
  const pathname = `project-screenshots/${normalizedProjectId}/${normalizedPageId}.jpg`;
  console.log("BLOB_UPLOAD_START", projectId, pageId, pathname);

  try {
    const result = await put(pathname, screenshotBuffer, {
      access: "public",
      addRandomSuffix: true,
      contentType: contentType || "image/jpeg"
    });
    const uploadedUrl = result && result.url ? String(result.url) : "";
    console.log("BLOB_UPLOAD_OK", projectId, pageId, uploadedUrl);
    return uploadedUrl;
  } catch (error) {
    console.error(
      "BLOB_UPLOAD_ERROR",
      projectId,
      pageId,
      error && error.message ? error.message : error
    );
    throw error;
  }
}

module.exports = {
  uploadScreenshotToBlob
};
