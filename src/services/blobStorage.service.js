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

  const normalizedProjectId = normalizePathSegment(projectId) || "project";
  const normalizedPageId = normalizePathSegment(pageId) || "page";
  const pathname = `project-screenshots/${normalizedProjectId}/${normalizedPageId}.jpg`;

  const result = await put(pathname, screenshotBuffer, {
    access: "public",
    addRandomSuffix: true,
    contentType: contentType || "image/jpeg"
  });

  return result && result.url ? String(result.url) : "";
}

module.exports = {
  uploadScreenshotToBlob
};
