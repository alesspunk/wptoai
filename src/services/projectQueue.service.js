const { uploadScreenshotToBlob } = require("./blobStorage.service");
const { captureSitePage, normalizeDetectedTitle } = require("./siteScan.service");
const projectRepository = require("../repositories/project.repository");
const projectPageRepository = require("../repositories/projectPage.repository");

const activeProjectQueues = new Map();

function normalizePageTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldAutoTitlePage(page) {
  const currentTitle = normalizePageTitle(page && page.title ? page.title : "");
  if (!currentTitle) return true;
  if (currentTitle === "Untitled Page") return true;
  if (/^Page \d+$/i.test(currentTitle)) return true;
  if (/^New page \d+$/i.test(currentTitle)) return true;
  return false;
}

function hasReadyScreenshot(page) {
  return Boolean(
    page &&
    page.status === "ready" &&
    String(page.screenshotUrl || "").trim()
  );
}

function isRealProjectPageType(type) {
  return type === "homepage" || type === "page";
}

function hasProjectQueueWork(pages) {
  return Array.isArray(pages) && pages.some((page) =>
    isRealProjectPageType(page && page.type) &&
    String(page && page.url ? page.url : "").trim() &&
    (
      (page.type === "homepage" && page.status === "queued") ||
      (page.status === "processing" && !hasReadyScreenshot(page))
    )
  );
}

async function processQueuedProjectPage(project, page) {
  let captured;
  console.log("PROJECT_QUEUE_CAPTURE_START", project.id, page.id, page.url);
  try {
    captured = await captureSitePage(page.url);
    console.log(
      "PROJECT_QUEUE_CAPTURE_OK",
      project.id,
      page.id,
      captured && captured.url ? captured.url : page.url
    );
  } catch (error) {
    console.error(
      "PROJECT_QUEUE_CAPTURE_ERROR",
      project.id,
      page.id,
      error && error.message ? error.message : error
    );
    throw error;
  }

  let screenshotUrl = "";
  console.log("PROJECT_QUEUE_BLOB_START", project.id, page.id);
  try {
    screenshotUrl = await uploadScreenshotToBlob(
      project.id,
      page.id,
      captured.screenshotBuffer,
      captured.contentType
    );
    console.log("PROJECT_QUEUE_BLOB_OK", project.id, page.id, screenshotUrl);
  } catch (error) {
    console.error(
      "PROJECT_QUEUE_BLOB_ERROR",
      project.id,
      page.id,
      error && error.message ? error.message : error
    );
    throw error;
  }

  const nextTitle = shouldAutoTitlePage(page)
    ? normalizeDetectedTitle(captured.title, captured.url, page.type === "homepage")
    : page.title;

  return projectPageRepository.updateProjectPageScanResult(project.id, page.id, {
    title: nextTitle,
    url: captured.url,
    status: "ready",
    screenshotUrl
  });
}

async function processNextProjectQueuePage(projectId) {
  const normalizedProjectId = String(projectId || "").trim();
  if (!normalizedProjectId) {
    return { page: null, hasPending: false };
  }

  if (activeProjectQueues.has(normalizedProjectId)) {
    return activeProjectQueues.get(normalizedProjectId);
  }

  const queuePromise = (async () => {
    const pages = await projectPageRepository.findProjectPagesByProjectId(normalizedProjectId);
    if (!hasProjectQueueWork(pages)) {
      return { page: null, hasPending: false };
    }

    const lockedProject = await projectRepository.tryAcquireProjectQueue(normalizedProjectId);
    if (!lockedProject || !lockedProject.id) {
      return { page: null, hasPending: true };
    }

    let processedPage = null;

    try {
      await projectRepository.touchProjectQueue(lockedProject.id);
      const page = await projectPageRepository.claimNextQueuedProjectPage(lockedProject.id);
      if (!page || !page.id) {
        return { page: null, hasPending: false };
      }

      try {
        processedPage = await processQueuedProjectPage(lockedProject, page);
        console.log("PROJECT_QUEUE_PAGE_READY", lockedProject.id, page.id);
      } catch (error) {
        console.error(
          "PROJECT_QUEUE_PAGE_ERROR",
          lockedProject.id,
          page.id,
          error && error.message ? error.message : error
        );
        processedPage = await projectPageRepository.updateProjectPageStatus(lockedProject.id, page.id, "failed");
        console.log("PROJECT_QUEUE_PAGE_FAILED", lockedProject.id, page.id);
      }

      const nextPages = await projectPageRepository.findProjectPagesByProjectId(lockedProject.id);
      return {
        page: processedPage,
        hasPending: hasProjectQueueWork(nextPages)
      };
    } finally {
      await projectRepository.releaseProjectQueue(lockedProject.id);
    }
  })()
    .catch((error) => {
      console.error(
        "PROJECT_QUEUE_ERROR",
        normalizedProjectId,
        error && error.message ? error.message : error
      );
      return { page: null, hasPending: true };
    })
    .finally(() => {
      activeProjectQueues.delete(normalizedProjectId);
    });

  activeProjectQueues.set(normalizedProjectId, queuePromise);
  return queuePromise;
}

module.exports = {
  processNextProjectQueuePage,
  hasProjectQueueWork
};
