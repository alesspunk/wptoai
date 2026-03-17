const fs = require("fs");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");
const { list } = require("@vercel/blob");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const buildJobRepository = require("../repositories/buildJob.repository");
const buildOutputRepository = require("../repositories/buildOutput.repository");
const projectRepository = require("../repositories/project.repository");
const projectPackageRepository = require("../repositories/projectPackage.repository");
const quoteRepository = require("../repositories/quote.repository");
const { sendEmail } = require("./email.service");

const BLOB_LIST_LIMIT = 1000;
const GITHUB_API_BASE = "https://api.github.com";
const VERCEL_API_BASE = "https://api.vercel.com";
const VERCEL_POLL_INTERVAL_MS = 3000;
const VERCEL_POLL_TIMEOUT_MS = 180000;
const MOBILE_VIEWPORT = {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
};

function createPreviewPublishError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = Number(statusCode || 500);
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRepoSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function buildRepositoryName(projectId) {
  return `wptoai-${normalizeRepoSegment(projectId) || "project"}`;
}

function buildCommitMessage(buildJobId) {
  return `Deploy build ${String(buildJobId || "").trim()}`;
}

function getPackageVersion(project, packageRecord) {
  return String(
    (packageRecord && packageRecord.packageVersion) ||
    (project && project.packageVersion) ||
    ""
  ).trim() || null;
}

function getProjectDisplayName(project, quote) {
  const siteTitle = String(quote && quote.siteTitle ? quote.siteTitle : "").trim();
  if (siteTitle) return siteTitle;

  const wordpressUrl = String(project && project.wordpressUrl ? project.wordpressUrl : "").trim();
  if (wordpressUrl) {
    try {
      return new URL(wordpressUrl).hostname;
    } catch (_error) {
      return wordpressUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "") || project.id;
    }
  }

  return String(project && project.id ? project.id : "WPtoAI Project");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim().toLowerCase());
}

function resolveProjectOwnerEmail(project, quote) {
  const candidates = [
    project && project.customerEmail,
    quote && quote.email
  ];

  for (const value of candidates) {
    const normalized = String(value || "").trim().toLowerCase();
    if (isValidEmail(normalized)) return normalized;
  }

  return "";
}

function resolveLocalExecutablePath() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) return envPath;

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium"
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return "";
}

async function launchBrowser() {
  const isVercelRuntime = Boolean(process.env.VERCEL);
  const useServerlessChromium = isVercelRuntime || process.platform === "linux";
  const executablePath = useServerlessChromium
    ? await chromium.executablePath()
    : resolveLocalExecutablePath();

  return puppeteer.launch({
    args: useServerlessChromium ? chromium.args : ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: MOBILE_VIEWPORT,
    executablePath: executablePath || undefined,
    headless: true,
    ignoreHTTPSErrors: true
  });
}

function withHttps(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value.replace(/^\/+/, "")}`;
}

function getPatchedValue(existing, patch, key) {
  return patch && Object.prototype.hasOwnProperty.call(patch, key)
    ? patch[key]
    : existing[key];
}

function mergePreviewLog(existingLog, patch) {
  const base = existingLog && typeof existingLog === "object" ? existingLog : {};
  const currentPreviewLog = base.previewPublish && typeof base.previewPublish === "object"
    ? base.previewPublish
    : {};

  return {
    ...base,
    previewPublish: {
      ...currentPreviewLog,
      ...patch
    }
  };
}

function serializeErrorDetails(error) {
  if (!error) return { message: "Unknown error" };
  return {
    message: String(error.message || "Unknown error"),
    statusCode: Number(error.statusCode || 0) || null
  };
}

async function saveBuildOutput(existingBuildOutput, patch) {
  if (!existingBuildOutput || !existingBuildOutput.buildJobId || !existingBuildOutput.projectId) {
    return null;
  }

  return buildOutputRepository.upsertBuildOutput({
    id: existingBuildOutput.id,
    buildJobId: existingBuildOutput.buildJobId,
    projectId: existingBuildOutput.projectId,
    quoteId: getPatchedValue(existingBuildOutput, patch, "quoteId"),
    provider: getPatchedValue(existingBuildOutput, patch, "provider") || "openai",
    status: getPatchedValue(existingBuildOutput, patch, "status") || "building",
    outputKey: getPatchedValue(existingBuildOutput, patch, "outputKey"),
    outputUrl: getPatchedValue(existingBuildOutput, patch, "outputUrl"),
    previewUrl: getPatchedValue(existingBuildOutput, patch, "previewUrl"),
    deploymentId: getPatchedValue(existingBuildOutput, patch, "deploymentId"),
    repositoryUrl: getPatchedValue(existingBuildOutput, patch, "repositoryUrl"),
    repositoryName: getPatchedValue(existingBuildOutput, patch, "repositoryName"),
    vercelProjectId: getPatchedValue(existingBuildOutput, patch, "vercelProjectId"),
    packageVersion: getPatchedValue(existingBuildOutput, patch, "packageVersion"),
    publishedAt: getPatchedValue(existingBuildOutput, patch, "publishedAt"),
    pageCountBuilt: getPatchedValue(existingBuildOutput, patch, "pageCountBuilt"),
    files: getPatchedValue(existingBuildOutput, patch, "files") || {},
    buildLog: getPatchedValue(existingBuildOutput, patch, "buildLog") || {}
  });
}

async function buildListAllBlobs(prefix) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw createPreviewPublishError("Blob storage is not configured. Missing BLOB_READ_WRITE_TOKEN.", 500);
  }

  const blobs = [];
  let cursor;
  let hasMore = true;

  while (hasMore) {
    const result = await list({
      token: process.env.BLOB_READ_WRITE_TOKEN,
      prefix,
      limit: BLOB_LIST_LIMIT,
      cursor
    });

    blobs.push(...(Array.isArray(result && result.blobs) ? result.blobs : []));
    hasMore = Boolean(result && result.hasMore && result.cursor);
    cursor = hasMore ? result.cursor : undefined;
  }

  return blobs;
}

function stripBlobPrefix(pathname, prefix) {
  const normalizedPathname = String(pathname || "").replace(/^\/+/, "");
  const normalizedPrefix = String(prefix || "").replace(/^\/+/, "").replace(/\/+$/, "");
  const expectedPrefix = `${normalizedPrefix}/`;
  if (!normalizedPathname.startsWith(expectedPrefix)) return "";
  return normalizedPathname.slice(expectedPrefix.length);
}

async function loadBuildArtifacts(buildJob) {
  if (!buildJob || !buildJob.id) {
    throw createPreviewPublishError("Build job is missing for Phase 5B.", 404);
  }

  if (String(buildJob.status || "").trim() !== "build_ready_for_publish") {
    console.warn(
      "PREVIEW_PUBLISH_PRECONDITION_SKIPPED",
      buildJob.id,
      buildJob.projectId || "n/a",
      buildJob.status || "unknown"
    );
    return null;
  }

  const buildOutputKey = String(buildJob.buildOutputKey || "").trim().replace(/\/+$/, "");
  const buildOutputUrl = String(buildJob.buildOutputUrl || "").trim();
  if (!buildOutputKey || !buildOutputUrl) {
    throw createPreviewPublishError("Build output location is missing from the build job.", 400);
  }

  const blobs = await buildListAllBlobs(`${buildOutputKey}/`);
  if (!blobs.length) {
    throw createPreviewPublishError(`No build artifacts were found in Blob for prefix "${buildOutputKey}".`, 404);
  }

  const files = [];
  for (const blob of blobs) {
    const relativePath = stripBlobPrefix(blob.pathname, buildOutputKey);
    if (!relativePath) continue;

    const response = await fetch(blob.url);
    if (!response.ok) {
      throw createPreviewPublishError(
        `Build artifact fetch failed for "${relativePath}" with status ${response.status}.`,
        502
      );
    }

    files.push({
      path: relativePath,
      contentType: String(blob.contentType || response.headers.get("content-type") || "application/octet-stream"),
      buffer: Buffer.from(await response.arrayBuffer()),
      sourceUrl: blob.url
    });
  }

  const hasIndexHtml = files.some((file) => file.path === "index.html");
  if (!hasIndexHtml) {
    throw createPreviewPublishError("The build output is missing required file index.html.", 400);
  }

  return {
    buildOutputKey,
    buildOutputUrl,
    files
  };
}

async function materializeDeploymentDirectory(files) {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "wptoai-preview-"));

  for (const file of files) {
    const filePath = path.join(tempDir, file.path);
    const parentDir = path.dirname(filePath);
    await fsPromises.mkdir(parentDir, { recursive: true });
    await fsPromises.writeFile(filePath, file.buffer);
  }

  return tempDir;
}

async function removeTemporaryDirectory(tempDir) {
  if (!tempDir) return;
  await fsPromises.rm(tempDir, { recursive: true, force: true });
}

async function githubRequest(method, pathname, body, options) {
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  if (!token) {
    throw createPreviewPublishError("GitHub is not configured. Missing GITHUB_TOKEN.", 500);
  }

  const url = `${GITHUB_API_BASE}${pathname}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "wptoai-phase5b",
      "x-github-api-version": "2022-11-28"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (response.status === 204) {
    return null;
  }

  let payload = null;
  const rawText = await response.text();
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch (_error) {
      payload = rawText;
    }
  }

  if (!response.ok) {
    if (response.status === 404 && options && options.allowNotFound) {
      return null;
    }

    const message = payload && typeof payload === "object" && payload.message
      ? payload.message
      : rawText || `GitHub API request failed with status ${response.status}.`;
    throw createPreviewPublishError(`GitHub API error: ${message}`, response.status);
  }

  return payload;
}

async function resolveGitHubOwner() {
  const authenticatedUser = await githubRequest("GET", "/user");
  const authenticatedLogin = String(authenticatedUser && authenticatedUser.login ? authenticatedUser.login : "").trim();
  const configuredOwner = String(process.env.GITHUB_OWNER || process.env.GITHUB_ORG || "").trim();
  const owner = configuredOwner || authenticatedLogin;
  if (!owner) {
    throw createPreviewPublishError("GitHub owner could not be determined.", 500);
  }

  return {
    owner,
    authenticatedLogin
  };
}

async function ensureGitHubRepository(repositoryName) {
  const ownerInfo = await resolveGitHubOwner();
  const owner = ownerInfo.owner;
  const existingRepo = await githubRequest(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`,
    null,
    { allowNotFound: true }
  );
  if (existingRepo) {
    return {
      owner,
      name: existingRepo.name,
      url: existingRepo.html_url,
      defaultBranch: existingRepo.default_branch || "main"
    };
  }

  const isOrganization = ownerInfo.authenticatedLogin &&
    owner.toLowerCase() !== ownerInfo.authenticatedLogin.toLowerCase();
  const createPath = isOrganization
    ? `/orgs/${encodeURIComponent(owner)}/repos`
    : "/user/repos";

  const createdRepo = await githubRequest("POST", createPath, {
    name: repositoryName,
    private: String(process.env.GITHUB_REPO_PRIVATE || "true").toLowerCase() !== "false",
    auto_init: true,
    description: `WPtoAI preview build repository for ${repositoryName}`
  });

  return {
    owner,
    name: createdRepo.name,
    url: createdRepo.html_url,
    defaultBranch: createdRepo.default_branch || "main"
  };
}

async function syncGitHubRepository(repository, files, commitMessage) {
  const ref = await githubRequest(
    "GET",
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/ref/heads/${encodeURIComponent(repository.defaultBranch)}`
  );
  const currentCommitSha = String(ref && ref.object && ref.object.sha ? ref.object.sha : "").trim();
  if (!currentCommitSha) {
    throw createPreviewPublishError("GitHub repository does not have a valid default branch head.", 500);
  }

  const treeEntries = files.map((file) => ({
    path: file.path,
    mode: "100644",
    type: "blob",
    content: file.buffer.toString("utf8")
  }));

  const tree = await githubRequest(
    "POST",
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees`,
    { tree: treeEntries }
  );
  const commit = await githubRequest(
    "POST",
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/commits`,
    {
      message: commitMessage,
      tree: tree.sha,
      parents: [currentCommitSha]
    }
  );

  await githubRequest(
    "PATCH",
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/refs/heads/${encodeURIComponent(repository.defaultBranch)}`,
    {
      sha: commit.sha,
      force: true
    }
  );

  return {
    branch: repository.defaultBranch,
    commitSha: commit.sha
  };
}

function buildVercelUrl(pathname) {
  const url = new URL(`${VERCEL_API_BASE}${pathname}`);
  const teamId = String(process.env.VERCEL_TEAM_ID || "").trim();
  if (teamId) {
    url.searchParams.set("teamId", teamId);
  }
  return url.toString();
}

async function vercelRequest(method, pathname, body, options) {
  const token = String(process.env.VERCEL_TOKEN || "").trim();
  if (!token) {
    throw createPreviewPublishError("Vercel is not configured. Missing VERCEL_TOKEN.", 500);
  }

  const response = await fetch(buildVercelUrl(pathname), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (response.status === 204) {
    return null;
  }

  const rawText = await response.text();
  let payload = null;
  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch (_error) {
      payload = rawText;
    }
  }

  if (!response.ok) {
    if (response.status === 404 && options && options.allowNotFound) {
      return null;
    }

    const message = payload && typeof payload === "object"
      ? (
          payload.error && payload.error.message
            ? payload.error.message
            : payload.message
        )
      : rawText;
    throw createPreviewPublishError(
      `Vercel API error: ${message || `Request failed with status ${response.status}.`}`,
      response.status
    );
  }

  return payload;
}

async function ensureVercelProject(projectName) {
  const existingProject = await vercelRequest(
    "GET",
    `/v9/projects/${encodeURIComponent(projectName)}`,
    null,
    { allowNotFound: true }
  );
  if (existingProject) {
    return {
      id: existingProject.id,
      name: existingProject.name || projectName
    };
  }

  const createdProject = await vercelRequest("POST", "/v10/projects", {
    name: projectName
  });

  return {
    id: createdProject.id,
    name: createdProject.name || projectName
  };
}

async function waitForVercelDeploymentReady(deploymentId) {
  const deadline = Date.now() + VERCEL_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const deployment = await vercelRequest(
      "GET",
      `/v13/deployments/${encodeURIComponent(deploymentId)}`
    );
    const readyState = String(deployment && deployment.readyState ? deployment.readyState : "").toUpperCase();

    if (readyState === "READY") {
      return {
        id: deployment.id,
        url: withHttps(deployment.aliasFinal || deployment.url),
        raw: deployment
      };
    }

    if (readyState === "ERROR" || readyState === "CANCELED") {
      throw createPreviewPublishError(
        `Vercel deployment ${deploymentId} finished with state ${readyState}.`,
        502
      );
    }

    await sleep(VERCEL_POLL_INTERVAL_MS);
  }

  throw createPreviewPublishError(`Timed out waiting for Vercel deployment ${deploymentId}.`, 504);
}

async function createVercelPreviewDeployment(params) {
  const deployment = await vercelRequest("POST", "/v13/deployments", {
    version: 2,
    name: params.vercelProject.name,
    project: params.vercelProject.id || params.vercelProject.name,
    files: params.files.map((file) => ({
      file: file.path,
      data: file.buffer.toString("utf8")
    })),
    projectSettings: {
      framework: null
    },
    meta: {
      wptoaiProjectId: params.project.id,
      wptoaiBuildJobId: params.buildJob.id,
      repositoryName: params.repository.name,
      packageVersion: params.packageVersion || ""
    },
    gitMetadata: {
      remoteUrl: params.repository.url,
      commitRef: params.gitCommit.branch,
      commitSha: params.gitCommit.commitSha,
      commitMessage: params.commitMessage,
      dirty: false
    }
  });

  const deploymentId = String(deployment && deployment.id ? deployment.id : "").trim();
  if (!deploymentId) {
    throw createPreviewPublishError("Vercel deployment did not return an id.", 502);
  }

  return waitForVercelDeploymentReady(deploymentId);
}

function toPreviewFileUrl(previewUrl, relativePath) {
  const normalizedPreviewUrl = withHttps(previewUrl);
  if (!normalizedPreviewUrl) return "";
  if (relativePath === "index.html") return normalizedPreviewUrl;
  return new URL(relativePath.replace(/^\/+/, ""), normalizedPreviewUrl.endsWith("/") ? normalizedPreviewUrl : `${normalizedPreviewUrl}/`).toString();
}

function isSkippableLink(value) {
  const href = String(value || "").trim();
  return !href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href);
}

function normalizeResolvedUrl(value, baseUrl) {
  if (isSkippableLink(value)) return "";

  try {
    const resolved = new URL(value, baseUrl);
    resolved.hash = "";
    return resolved.toString();
  } catch (_error) {
    return "";
  }
}

function isSameOrigin(candidateUrl, previewUrl) {
  try {
    return new URL(candidateUrl).origin === new URL(previewUrl).origin;
  } catch (_error) {
    return false;
  }
}

function isHtmlUrl(candidateUrl) {
  try {
    const pathname = new URL(candidateUrl).pathname || "/";
    if (pathname === "/" || pathname.endsWith("/")) return true;
    return !/\.[a-z0-9]+$/i.test(pathname) || pathname.endsWith(".html");
  } catch (_error) {
    return false;
  }
}

function collectRegexMatches(text, regex, baseUrl) {
  const values = new Set();
  let match;

  while ((match = regex.exec(text))) {
    const candidate = normalizeResolvedUrl(match[1], baseUrl);
    if (candidate) values.add(candidate);
  }

  return values;
}

function collectCssAssetUrls(cssText, baseUrl) {
  const values = new Set();
  const pattern = /url\((['"]?)([^'")]+)\1\)/gi;
  let match;

  while ((match = pattern.exec(cssText))) {
    const candidate = normalizeResolvedUrl(match[2], baseUrl);
    if (candidate) values.add(candidate);
  }

  return values;
}

async function fetchForValidation(url) {
  const response = await fetch(url, { redirect: "follow" });
  const text = response.ok ? await response.text() : "";
  return { response, text };
}

async function validateMobileViewport(previewUrl) {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport(MOBILE_VIEWPORT);
    const response = await page.goto(previewUrl, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    if (!response || !response.ok()) {
      throw createPreviewPublishError("Mobile viewport validation could not load the preview homepage.", 502);
    }

    return page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText.trim() : "";
      const documentWidth = document.documentElement ? document.documentElement.scrollWidth : 0;
      return {
        bodyHasContent: Boolean(bodyText),
        hasStylesheets: document.styleSheets.length > 0,
        noHorizontalOverflow: documentWidth <= window.innerWidth + 1
      };
    });
  } finally {
    await browser.close();
  }
}

async function validatePreviewDeployment(previewUrl, files) {
  const normalizedPreviewUrl = withHttps(previewUrl);
  const errors = [];
  const htmlUrls = new Set();
  const cssUrls = new Set();
  const jsUrls = new Set();
  const assetUrls = new Set();
  const internalLinkUrls = new Set();

  files.forEach((file) => {
    if (file.path.endsWith(".html")) {
      htmlUrls.add(toPreviewFileUrl(normalizedPreviewUrl, file.path));
      return;
    }
    if (file.path.endsWith(".css")) {
      cssUrls.add(toPreviewFileUrl(normalizedPreviewUrl, file.path));
      return;
    }
    if (file.path.endsWith(".js")) {
      jsUrls.add(toPreviewFileUrl(normalizedPreviewUrl, file.path));
      return;
    }
    if (file.path.indexOf("assets/") === 0) {
      assetUrls.add(toPreviewFileUrl(normalizedPreviewUrl, file.path));
    }
  });

  let indexChecked = false;
  for (const pageUrl of htmlUrls) {
    const { response, text } = await fetchForValidation(pageUrl);
    if (!response.ok) {
      errors.push(`HTML page returned ${response.status}: ${pageUrl}`);
      continue;
    }

    if (!indexChecked && pageUrl === normalizedPreviewUrl) {
      indexChecked = true;
      if (!/<html[\s>]/i.test(text)) {
        errors.push(`index.html did not load correctly at ${pageUrl}`);
      }
    }

    collectRegexMatches(text, /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, pageUrl)
      .forEach((candidate) => {
        if (!isSameOrigin(candidate, normalizedPreviewUrl)) return;
        if (candidate.endsWith(".css")) cssUrls.add(candidate);
      });

    collectRegexMatches(text, /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi, pageUrl)
      .forEach((candidate) => {
        if (!isSameOrigin(candidate, normalizedPreviewUrl)) return;
        jsUrls.add(candidate);
      });

    collectRegexMatches(text, /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi, pageUrl)
      .forEach((candidate) => {
        if (!isSameOrigin(candidate, normalizedPreviewUrl)) return;
        if (!isHtmlUrl(candidate)) return;
        internalLinkUrls.add(candidate);
      });

    collectRegexMatches(text, /<(?:img|source|video|audio|iframe|embed)\b[^>]*src=["']([^"']+)["'][^>]*>/gi, pageUrl)
      .forEach((candidate) => {
        if (!isSameOrigin(candidate, normalizedPreviewUrl)) return;
        assetUrls.add(candidate);
      });
  }

  if (!indexChecked) {
    const { response, text } = await fetchForValidation(normalizedPreviewUrl);
    if (!response.ok) {
      errors.push(`Preview root returned ${response.status}: ${normalizedPreviewUrl}`);
    } else if (!/<html[\s>]/i.test(text)) {
      errors.push(`index.html did not load correctly at ${normalizedPreviewUrl}`);
    }
  }

  for (const cssUrl of cssUrls) {
    const { response, text } = await fetchForValidation(cssUrl);
    if (!response.ok) {
      errors.push(`CSS file returned ${response.status}: ${cssUrl}`);
      continue;
    }

    collectCssAssetUrls(text, cssUrl).forEach((candidate) => {
      if (!isSameOrigin(candidate, normalizedPreviewUrl)) return;
      assetUrls.add(candidate);
    });
  }

  for (const jsUrl of jsUrls) {
    const response = await fetch(jsUrl, { redirect: "follow" });
    if (!response.ok) {
      errors.push(`JavaScript file returned ${response.status}: ${jsUrl}`);
    } else {
      await response.arrayBuffer();
    }
  }

  for (const assetUrl of assetUrls) {
    const response = await fetch(assetUrl, { redirect: "follow" });
    if (!response.ok) {
      errors.push(`Asset returned ${response.status}: ${assetUrl}`);
    } else {
      await response.arrayBuffer();
    }
  }

  for (const linkUrl of internalLinkUrls) {
    const response = await fetch(linkUrl, { redirect: "follow" });
    if (!response.ok) {
      errors.push(`Internal link returned ${response.status}: ${linkUrl}`);
    } else {
      await response.arrayBuffer();
    }
  }

  let mobileValidation = null;
  try {
    mobileValidation = await validateMobileViewport(normalizedPreviewUrl);
    if (!mobileValidation.bodyHasContent) {
      errors.push("Mobile viewport validation found an empty page body.");
    }
    if (!mobileValidation.hasStylesheets) {
      errors.push("Mobile viewport validation found no loaded stylesheets.");
    }
    if (!mobileValidation.noHorizontalOverflow) {
      errors.push("Mobile viewport validation detected horizontal overflow.");
    }
  } catch (error) {
    errors.push(error && error.message ? error.message : "Mobile viewport validation failed.");
  }

  return {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    pagesChecked: htmlUrls.size,
    cssChecked: cssUrls.size,
    jsChecked: jsUrls.size,
    assetsChecked: assetUrls.size,
    internalLinksChecked: internalLinkUrls.size,
    mobileValidation: mobileValidation || null,
    errors
  };
}

async function sendPreviewReadyEmail(project, quote, previewUrl, publishedAt) {
  const recipient = resolveProjectOwnerEmail(project, quote);
  if (!recipient) {
    throw createPreviewPublishError("Project owner email is missing, so the preview notification could not be sent.", 400);
  }

  const projectName = getProjectDisplayName(project, quote);
  await sendEmail(
    recipient,
    "Your preview site is ready",
    [
      "<p>Your preview site is ready.</p>",
      `<p><strong>Project:</strong> ${projectName}</p>`,
      `<p><strong>Preview URL:</strong> <a href="${previewUrl}">${previewUrl}</a></p>`,
      `<p><strong>Timestamp:</strong> ${publishedAt}</p>`,
      "<p>— WPtoAI</p>"
    ].join("")
  );
}

async function processClaimedPreviewPublish(buildOutput) {
  if (!buildOutput || !buildOutput.buildJobId) {
    return { processed: false, buildOutput: null, buildJob: null };
  }

  let currentBuildOutput = buildOutput;
  let project = null;
  let buildJob = null;
  let quote = null;
  let packageRecord = null;
  let tempDir = "";
  let deploymentMetadata = {
    previewUrl: currentBuildOutput.previewUrl || null,
    deploymentId: currentBuildOutput.deploymentId || null,
    repositoryUrl: currentBuildOutput.repositoryUrl || null,
    repositoryName: currentBuildOutput.repositoryName || null,
    vercelProjectId: currentBuildOutput.vercelProjectId || null,
    packageVersion: currentBuildOutput.packageVersion || null,
    publishedAt: currentBuildOutput.publishedAt || null
  };

  try {
    buildJob = await buildJobRepository.findBuildJobById(buildOutput.buildJobId);
    if (!buildJob) {
      throw createPreviewPublishError("The preview publish worker could not find the build job.", 404);
    }

    if (String(buildJob.status || "").trim() !== "build_ready_for_publish") {
      console.warn(
        "PREVIEW_PUBLISH_PRECONDITION_SKIPPED",
        buildJob.id,
        buildJob.projectId || "n/a",
        buildJob.status || "unknown"
      );
      return {
        processed: false,
        buildJob,
        buildOutput,
        project: null,
        warning: "Build job is not ready for preview publish."
      };
    }

    project = await projectRepository.findProjectById(buildJob.projectId || buildOutput.projectId);
    if (!project) {
      throw createPreviewPublishError("The preview publish worker could not find the project.", 404);
    }

    packageRecord = await projectPackageRepository.findProjectPackageByProjectId(project.id);
    quote = project.quoteId ? await quoteRepository.findQuoteById(project.quoteId) : null;
    const packageVersion = getPackageVersion(project, packageRecord);

    currentBuildOutput = await saveBuildOutput(currentBuildOutput, {
      status: "publishing_preview",
      packageVersion,
      buildLog: mergePreviewLog(currentBuildOutput.buildLog, {
        startedAt: new Date().toISOString(),
        stage: "publishing_preview"
      })
    });

    project = await projectRepository.updateProjectDeployment(project.id, {
      status: "deploying"
    });

    const artifacts = await loadBuildArtifacts(buildJob);
    tempDir = await materializeDeploymentDirectory(artifacts.files);

    const repositoryName = buildRepositoryName(project.id);
    const commitMessage = buildCommitMessage(buildJob.id);
    const repository = await ensureGitHubRepository(repositoryName);
    const gitCommit = await syncGitHubRepository(repository, artifacts.files, commitMessage);
    const vercelProject = await ensureVercelProject(repositoryName);
    const deployment = await createVercelPreviewDeployment({
      vercelProject,
      repository,
      gitCommit,
      commitMessage,
      files: artifacts.files,
      project,
      buildJob,
      packageVersion
    });

    const publishedAt = new Date().toISOString();
    deploymentMetadata = {
      previewUrl: deployment.url,
      deploymentId: deployment.id,
      repositoryUrl: repository.url,
      repositoryName: repository.name,
      vercelProjectId: vercelProject.id,
      packageVersion,
      publishedAt
    };

    currentBuildOutput = await saveBuildOutput(currentBuildOutput, {
      status: "preview_ready",
      previewUrl: deploymentMetadata.previewUrl,
      deploymentId: deploymentMetadata.deploymentId,
      repositoryUrl: deploymentMetadata.repositoryUrl,
      repositoryName: deploymentMetadata.repositoryName,
      vercelProjectId: deploymentMetadata.vercelProjectId,
      packageVersion: deploymentMetadata.packageVersion,
      publishedAt: deploymentMetadata.publishedAt,
      buildLog: mergePreviewLog(currentBuildOutput.buildLog, {
        stage: "deployed",
        repositoryUrl: deploymentMetadata.repositoryUrl,
        repositoryName: deploymentMetadata.repositoryName,
        vercelProjectId: deploymentMetadata.vercelProjectId,
        deploymentId: deploymentMetadata.deploymentId,
        previewUrl: deploymentMetadata.previewUrl,
        publishedAt: deploymentMetadata.publishedAt,
        commitSha: gitCommit.commitSha,
        commitRef: gitCommit.branch
      })
    });

    const validation = await validatePreviewDeployment(deploymentMetadata.previewUrl, artifacts.files);
    if (!validation.ok) {
      currentBuildOutput = await saveBuildOutput(currentBuildOutput, {
        status: "preview_failed_validation",
        buildLog: mergePreviewLog(currentBuildOutput.buildLog, {
          stage: "preview_failed_validation",
          validation
        })
      });
      project = await projectRepository.updateProjectDeployment(project.id, {
        status: "failed",
        vercelDeploymentUrl: deploymentMetadata.previewUrl
      });

      const validationError = createPreviewPublishError(
        validation.errors[0] || "Preview validation failed.",
        422
      );
      validationError.finalStatus = "preview_failed_validation";
      validationError.validation = validation;
      throw validationError;
    }

    await sendPreviewReadyEmail(project, quote, deploymentMetadata.previewUrl, deploymentMetadata.publishedAt);
    currentBuildOutput = await saveBuildOutput(currentBuildOutput, {
      status: "preview_ready",
      buildLog: mergePreviewLog(currentBuildOutput.buildLog, {
        stage: "preview_ready",
        validation,
        notificationSentAt: new Date().toISOString()
      })
    });
    project = await projectRepository.updateProjectDeployment(project.id, {
      status: "ready",
      vercelDeploymentUrl: deploymentMetadata.previewUrl
    });

    return {
      processed: true,
      buildJob,
      buildOutput: currentBuildOutput,
      project,
      validation,
      previewUrl: deploymentMetadata.previewUrl
    };
  } catch (error) {
    const finalStatus = String(error && error.finalStatus ? error.finalStatus : "preview_failed");

    try {
      currentBuildOutput = await saveBuildOutput(currentBuildOutput, {
        status: finalStatus,
        previewUrl: deploymentMetadata.previewUrl,
        deploymentId: deploymentMetadata.deploymentId,
        repositoryUrl: deploymentMetadata.repositoryUrl,
        repositoryName: deploymentMetadata.repositoryName,
        vercelProjectId: deploymentMetadata.vercelProjectId,
        packageVersion: deploymentMetadata.packageVersion,
        publishedAt: deploymentMetadata.publishedAt,
        buildLog: mergePreviewLog(currentBuildOutput.buildLog, {
          stage: finalStatus,
          error: serializeErrorDetails(error),
          validation: error && error.validation ? error.validation : undefined
        })
      });
    } catch (persistError) {
      console.error(
        "PREVIEW_PUBLISH_PERSIST_ERROR",
        buildOutput.buildJobId,
        persistError && persistError.message ? persistError.message : persistError
      );
    }

    if (project && project.id) {
      try {
        await projectRepository.updateProjectDeployment(project.id, {
          status: "failed",
          vercelDeploymentUrl: deploymentMetadata.previewUrl
            ? deploymentMetadata.previewUrl
            : project.vercelDeploymentUrl
        });
      } catch (projectError) {
        console.error(
          "PREVIEW_PUBLISH_PROJECT_UPDATE_ERROR",
          project.id,
          projectError && projectError.message ? projectError.message : projectError
        );
      }
    }

    throw error;
  } finally {
    await removeTemporaryDirectory(tempDir);
  }
}

async function runNextPreviewPublishJob() {
  const buildOutput = await buildOutputRepository.claimNextBuildOutputReadyForPublish();
  if (!buildOutput) {
    return {
      processed: false,
      buildOutput: null,
      buildJob: null,
      project: null
    };
  }

  return processClaimedPreviewPublish(buildOutput);
}

module.exports = {
  processClaimedPreviewPublish,
  runNextPreviewPublishJob
};
