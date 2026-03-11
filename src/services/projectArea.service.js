const crypto = require("crypto");
const { sendEmail } = require("./email.service");
const projectQueueService = require("./projectQueue.service");
const projectService = require("./project.service");
const { normalizeDetectedTitle } = require("./siteScan.service");
const quoteRepository = require("../repositories/quote.repository");
const emailUpdateTokenRepository = require("../repositories/emailUpdateToken.repository");
const projectRepository = require("../repositories/project.repository");
const projectPageRepository = require("../repositories/projectPage.repository");
const userRepository = require("../repositories/user.repository");

function normalizeSiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = raw.startsWith("http://") || raw.startsWith("https://")
      ? new URL(raw)
      : new URL(`https://${raw}`);
    return url.toString();
  } catch (_error) {
    return raw;
  }
}

function deriveDetectedPages(quote) {
  const fromScan = Number(quote && quote.detectedPages ? quote.detectedPages : 0);
  if (fromScan > 0) return fromScan;
  const fromPlan = Number(quote && quote.plan && quote.plan.pages ? quote.plan.pages : 0);
  if (fromPlan > 0) return fromPlan;
  return 1;
}

function derivePurchasedPages(quote, detectedPages) {
  const fromPlan = Number(quote && quote.plan && quote.plan.pages ? quote.plan.pages : 0);
  if (fromPlan > 0) return Math.max(fromPlan, detectedPages);
  return detectedPages;
}

function makeFallbackPageTitle(index) {
  if (index === 0) return "Homepage";
  return `Page ${index + 1}`;
}

function getDetectedPagesData(quote) {
  return Array.isArray(quote && quote.detectedPagesData) ? quote.detectedPagesData : [];
}

function normalizePredictedSections(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter((item) => {
      if (!item) return false;
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function getHomepagePreviewImageUrl(quote) {
  return String((quote && quote.previewImageUrl) || "").trim();
}

function buildDetectedPageMetaLookup(quote) {
  const lookup = new Map();
  getDetectedPagesData(quote).forEach((page, index) => {
    const normalizedUrl = normalizePageUrl(page && page.url ? page.url : "");
    if (!normalizedUrl) return;
    lookup.set(normalizedUrl, {
      orderIndex: Number.isFinite(Number(page && page.orderIndex)) ? Number(page.orderIndex) : index,
      predictedSections: normalizePredictedSections(page && page.predictedSections)
    });
  });
  return lookup;
}

function isGenericProjectPageTitle(value) {
  const normalized = normalizePageTitle(value);
  if (!normalized) return true;
  if (/^page \d+$/i.test(normalized)) return true;
  if (/^new page \d+$/i.test(normalized)) return true;
  if (/^untitled(?: page)?$/i.test(normalized)) return true;
  return false;
}

function buildFallbackDetectedPages(siteUrl, detectedPages) {
  let rootOrigin = "";
  try {
    rootOrigin = siteUrl ? new URL(siteUrl).origin : "";
  } catch (_error) {
    rootOrigin = "";
  }

  const pages = [{
    title: "Home",
    url: rootOrigin || siteUrl || "",
    type: "homepage",
    orderIndex: 0
  }];

  for (let index = 1; index < detectedPages; index += 1) {
    const slug = `page-${index + 1}`;
    pages.push({
      title: makeFallbackPageTitle(index),
      url: rootOrigin ? `${rootOrigin}/${slug}` : "",
      type: "page",
      orderIndex: index
    });
  }

  return pages;
}

function buildInitialProjectPages({ project, quote }) {
  const siteUrl = normalizeSiteUrl(
    (project && project.wordpressUrl) ||
    (quote && quote.siteUrl) ||
    ""
  );
  const detectedPages = deriveDetectedPages(quote);
  const sourcePages = getDetectedPagesData(quote).length
    ? getDetectedPagesData(quote)
    : buildFallbackDetectedPages(siteUrl, detectedPages);

  return sourcePages.map((page, index) => {
    const normalizedUrl = normalizePageUrl(page && page.url ? page.url : "");
    const type = index === 0 ? "homepage" : "page";
    const hasHomepagePreview = type === "homepage" && Boolean(getHomepagePreviewImageUrl(quote));
    return {
      title: normalizeDetectedTitle(
        page && page.title ? page.title : "",
        normalizedUrl,
        type === "homepage"
      ),
      url: normalizedUrl,
      type,
      parentId: null,
      status: hasHomepagePreview ? "ready" : (type === "homepage" ? "queued" : "ready"),
      screenshotUrl: "",
      orderIndex: Number.isFinite(Number(page && page.orderIndex)) ? Number(page.orderIndex) : index
    };
  });
}

function toApiPage(page, quote) {
  const detectedPageMetaLookup = buildDetectedPageMetaLookup(quote);
  const normalizedUrl = normalizePageUrl(page && page.url ? page.url : "");
  const detectedPageMeta = normalizedUrl ? detectedPageMetaLookup.get(normalizedUrl) : null;
  const predictedSections = normalizePredictedSections(
    detectedPageMeta && detectedPageMeta.predictedSections
      ? detectedPageMeta.predictedSections
      : []
  );
  const homepagePreviewImageUrl = page && page.type === "homepage" && !String(page.screenshotUrl || "").trim()
    ? getHomepagePreviewImageUrl(quote)
    : "";
  const screenshotUrl = String(page && page.screenshotUrl ? page.screenshotUrl : "").trim() || homepagePreviewImageUrl;
  let status = String(page && page.status ? page.status : "queued");
  if (screenshotUrl) {
    status = "ready";
  } else if (page && page.type !== "homepage" && status === "queued") {
    status = "ready";
  }

  return {
    id: page.id,
    title: page.title,
    url: normalizedUrl,
    type: page.type,
    parentId: page.parentId || null,
    persisted: true,
    status,
    screenshotUrl,
    orderIndex: Number(page.orderIndex || 0),
    predictedSections
  };
}

function normalizePageTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return raw;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function generateEmailUpdateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function computeEmailUpdateExpiry() {
  return new Date(Date.now() + (30 * 60 * 1000)).toISOString();
}

async function resolveProjectUser(project) {
  if (project && project.userId) {
    const existingUser = await userRepository.findUserById(project.userId);
    if (existingUser) return existingUser;
  }

  const email = String(project && project.customerEmail ? project.customerEmail : "").trim().toLowerCase();
  if (!email) return null;

  const found = await userRepository.findUserByEmail(email);
  if (found) return found;
  return userRepository.createUser(email);
}

function isRealProjectPageType(type) {
  return type === "homepage" || type === "page";
}

function isPurchasedProjectPageType(type) {
  return type === "homepage" || type === "page" || type === "section";
}

function isPreparedProjectPage(page) {
  if (!page || !isRealProjectPageType(page.type)) return false;
  if (page.type === "homepage") {
    return Boolean(String(page.screenshotUrl || "").trim() || String(page.url || "").trim());
  }
  if (Array.isArray(page.predictedSections) && page.predictedSections.length > 0) {
    return true;
  }
  if (!isGenericProjectPageTitle(page.title)) {
    return true;
  }
  return Boolean(String(page.screenshotUrl || "").trim());
}

function toSummary({ project, quote, pages }) {
  const realPages = pages.filter((item) => isRealProjectPageType(item.type));
  const preparedPageCount = realPages.filter((item) => isPreparedProjectPage(item)).length;
  const totalRealPageCount = realPages.length || deriveDetectedPages(quote);
  const purchasedPages = derivePurchasedPages(quote, totalRealPageCount);
  const usedPages = pages.filter((item) => isPurchasedProjectPageType(item.type)).length;
  const remainingPages = Math.max(0, purchasedPages - usedPages);
  const homepage = realPages.find((item) => item.type === "homepage");
  const innerPages = realPages.filter((item) => item.type === "page");
  const preparedInnerPages = innerPages.filter((item) => isPreparedProjectPage(item)).length;
  let migrationProgress = 0;
  if (homepage && isPreparedProjectPage(homepage)) {
    migrationProgress += 20;
  }
  if (realPages.length > 0) {
    migrationProgress += 20;
  }
  if (innerPages.length > 0) {
    migrationProgress += Math.round((preparedInnerPages / innerPages.length) * 20);
  } else if (homepage) {
    migrationProgress += 20;
  }
  migrationProgress = Math.max(0, Math.min(60, migrationProgress));

  return {
    projectId: project.id,
    status: project.status || "queued",
    wordpressUrl: project.wordpressUrl || "",
    customerEmail: project.customerEmail || "",
    queueActive: projectQueueService.hasProjectQueueWork(pages),
    migrationProgress,
    detectedPages: totalRealPageCount,
    purchasedPages,
    usedPages,
    remainingPages,
    processedPageCount: preparedPageCount,
    totalRealPageCount,
    purchasedPageCount: purchasedPages,
    usedPageCount: usedPages,
    remainingPageCount: remainingPages
  };
}

async function loadProjectQuote(project) {
  return project && project.quoteId
    ? quoteRepository.findQuoteById(project.quoteId)
    : null;
}

async function getOrSeedProjectPages(project, quote) {
  return projectPageRepository.seedProjectPagesIfEmpty(
    project.id,
    buildInitialProjectPages({ project, quote })
  );
}

async function buildProjectAreaData(project, quote, selectedPageId) {
  const seeded = await getOrSeedProjectPages(project, quote);
  const pages = (seeded || []).map((page) => toApiPage(page, quote));
  const summary = toSummary({ project, quote, pages });
  const selectedPage = pages.find((item) => item.id === selectedPageId) || pages[0] || null;

  return {
    ...summary,
    siteTitle: String((quote && quote.siteTitle) || "Project Area"),
    siteDescription: String((quote && quote.siteDescription) || ""),
    previewImageUrl: String((quote && quote.previewImageUrl) || ""),
    selectedPage: selectedPage ? { ...selectedPage } : null,
    pages
  };
}

async function getProjectAreaData(project, selectedPageId) {
  const quote = project && project.quoteId
    ? await quoteRepository.findQuoteById(project.quoteId)
    : null;
  return buildProjectAreaData(project, quote, selectedPageId);
}

async function renameProjectAreaPage(project, pageId, title, url) {
  if (!project || !project.id) {
    throw new Error("Project not found.");
  }

  const page = await projectPageRepository.findProjectPageById(project.id, pageId);
  if (!page) {
    throw new Error("Project page not found.");
  }
  if (page.type === "homepage") {
    throw new Error("Homepage rename is not available here.");
  }

  const normalizedTitle = normalizePageTitle(title);
  const normalizedUrl = normalizePageUrl(url);
  if (!normalizedTitle) {
    throw new Error("Page name cannot be empty.");
  }

  const updated = await projectPageRepository.updateProjectPageTitle(
    project.id,
    page.id,
    normalizedTitle,
    normalizedUrl || page.url || ""
  );
  if (!updated) {
    throw new Error("Could not rename page.");
  }
  return toApiPage(updated);
}

async function saveProjectAreaPageOrder(project, updates) {
  if (!project || !project.id) {
    throw new Error("Project not found.");
  }
  if (!Array.isArray(updates) || !updates.length) {
    throw new Error("No page updates provided.");
  }

  const normalizedUpdates = updates
    .map((item, index) => ({
      id: String(item && item.id ? item.id : "").trim(),
      parentId: item && item.parentId ? String(item.parentId).trim() : null,
      type: String(item && item.type ? item.type : "").trim().toLowerCase() || "page",
      orderIndex: Number.isFinite(Number(item && item.orderIndex)) ? Number(item.orderIndex) : index
    }))
    .filter((item) => item.id);

  if (!normalizedUpdates.length) {
    throw new Error("No valid page updates provided.");
  }

  const allPages = await projectPageRepository.findProjectPagesByProjectId(project.id);
  const pageMap = new Map();
  allPages.forEach((page) => {
    pageMap.set(page.id, page);
  });

  const nextPageMap = new Map();
  allPages.forEach((page) => {
    nextPageMap.set(page.id, {
      id: page.id,
      type: page.type,
      parentId: page.parentId || null
    });
  });

  normalizedUpdates.forEach((item) => {
    const page = nextPageMap.get(item.id);
    if (!page) return;
    if (item.type === "homepage" || item.type === "page" || item.type === "section") {
      page.type = item.type;
    }
    page.parentId = item.parentId || null;
  });

  normalizedUpdates.forEach((item) => {
    const page = nextPageMap.get(item.id);
    if (!page) {
      throw new Error("Project page not found.");
    }
    if (page.type !== "homepage" && page.type !== "page" && page.type !== "section") {
      throw new Error("Invalid project page type.");
    }
    if (page.type === "homepage" && item.parentId) {
      throw new Error("Homepage cannot be moved into a section.");
    }
    if (item.parentId) {
      const parent = nextPageMap.get(item.parentId);
      if (!parent || parent.type !== "section") {
        throw new Error("Pages can only be dropped into sections.");
      }
      if (parent.id === page.id) {
        throw new Error("A page cannot be moved into itself.");
      }
    }
  });

  await projectPageRepository.updateProjectPageOrder(project.id, normalizedUpdates);
  const savedPages = await projectPageRepository.findProjectPagesByProjectId(project.id);
  return savedPages.map(toApiPage);
}

async function createProjectAreaPage(project, parentId) {
  if (!project || !project.id) {
    throw new Error("Project not found.");
  }

  const quote = await loadProjectQuote(project);
  const pages = await getOrSeedProjectPages(project, quote);
  const purchasedPages = derivePurchasedPages(quote, pages.filter((item) => isRealProjectPageType(item.type)).length);
  const usedPages = pages.filter((item) => isPurchasedProjectPageType(item.type)).length;
  if (usedPages >= purchasedPages) {
    throw new Error("No remaining purchased pages. Delete a page to free one slot.");
  }

  const normalizedParentId = parentId ? String(parentId).trim() : null;
  if (normalizedParentId) {
    const parentPage = pages.find((item) => item.id === normalizedParentId);
    if (!parentPage || parentPage.type !== "section") {
      throw new Error("Pages can only be added inside sections.");
    }
  }

  const siblingCount = pages.filter((item) => (item.parentId || null) === normalizedParentId).length;
  const created = await projectPageRepository.createProjectPage(project.id, {
    title: "Untitled Page",
    url: null,
    type: "page",
    parentId: normalizedParentId,
    status: "ready",
    screenshotUrl: null,
    orderIndex: siblingCount
  });

  const nextPages = pages.concat(created);
  const apiPages = nextPages.map((item) => toApiPage(item, quote));
  const summary = toSummary({ project, quote, pages: apiPages });

  return {
    page: toApiPage(created, quote),
    summary
  };
}

function collectDescendantPageIds(pages, rootId) {
  const ids = [rootId];
  const queue = [rootId];

  while (queue.length) {
    const parentId = queue.shift();
    pages.forEach((page) => {
      if ((page.parentId || null) !== parentId) return;
      ids.push(page.id);
      if (page.type === "section") {
        queue.push(page.id);
      }
    });
  }

  return Array.from(new Set(ids));
}

async function deleteProjectAreaPage(project, pageId) {
  if (!project || !project.id) {
    throw new Error("Project not found.");
  }

  const normalizedPageId = String(pageId || "").trim();
  if (!normalizedPageId) {
    throw new Error("Project page not found.");
  }

  const quote = await loadProjectQuote(project);
  const pages = await getOrSeedProjectPages(project, quote);
  const target = pages.find((item) => item.id === normalizedPageId);
  if (!target) {
    throw new Error("Project page not found.");
  }
  if (target.type === "homepage") {
    throw new Error("Homepage cannot be deleted.");
  }

  const idsToDelete = target.type === "section"
    ? collectDescendantPageIds(pages, target.id)
    : [target.id];

  await projectPageRepository.deleteProjectPagesByIds(project.id, idsToDelete);
  const nextPages = await projectPageRepository.findProjectPagesByProjectId(project.id);
  const apiPages = nextPages.map((item) => toApiPage(item, quote));

  return {
    pages: apiPages,
    summary: toSummary({ project, quote, pages: apiPages })
  };
}

async function processProjectAreaPage(project, pageId, requestedUrl) {
  if (!project || !project.id) {
    throw new Error("Project not found.");
  }

  const quote = await loadProjectQuote(project);
  await getOrSeedProjectPages(project, quote);

  let page = null;
  const normalizedRequestedUrl = normalizePageUrl(requestedUrl || "");
  const explicitPageId = String(pageId || "").trim();

  if (explicitPageId) {
    page = await projectPageRepository.findProjectPageById(project.id, explicitPageId);
    if (!page) {
      throw new Error("Project page not found.");
    }
    if (!isRealProjectPageType(page.type)) {
      throw new Error("Only homepage and inner pages can be scanned.");
    }
    const finalUrl = normalizedRequestedUrl || normalizePageUrl(page.url || "");
    if (!finalUrl) {
      throw new Error("Enter a valid page URL to scan.");
    }
    const currentUrl = normalizePageUrl(page.url || "");
    const currentScreenshotUrl = String(page.screenshotUrl || "").trim();
    const urlChanged = Boolean(currentUrl && finalUrl && currentUrl !== finalUrl);

    if (
      currentScreenshotUrl &&
      page.status === "ready" &&
      !urlChanged
    ) {
      const existingPages = await projectPageRepository.findProjectPagesByProjectId(project.id);
      const apiPages = existingPages.map((item) => toApiPage(item, quote));
      return {
        page: toApiPage(page, quote),
        summary: toSummary({ project, quote, pages: apiPages }),
        hasPending: projectQueueService.hasProjectQueueWork(apiPages)
      };
    }

    if (currentScreenshotUrl && urlChanged) {
      await projectPageRepository.clearProjectPageScreenshot(project.id, page.id);
    }

    if (page.status !== "processing" || urlChanged || currentUrl !== finalUrl) {
      page = await projectPageRepository.updateProjectPageScanResult(project.id, page.id, {
        url: finalUrl,
        status: "processing"
      });
    }
  } else {
    const processed = await projectQueueService.processNextProjectQueuePage(project.id);
    const existingPages = await projectPageRepository.findProjectPagesByProjectId(project.id);
    const apiPages = existingPages.map((item) => toApiPage(item, quote));
    return {
      page: processed && processed.page ? toApiPage(processed.page, quote) : null,
      summary: toSummary({ project, quote, pages: apiPages }),
      hasPending: Boolean(processed && processed.hasPending)
    };
  }

  const existingPages = await projectPageRepository.findProjectPagesByProjectId(project.id);
  const apiPages = existingPages.map((item) => toApiPage(item, quote));
  const queuedPage = apiPages.find((item) => item.id === explicitPageId) || null;

  return {
    page: queuedPage,
    summary: toSummary({ project, quote, pages: apiPages }),
    hasPending: projectQueueService.hasProjectQueueWork(apiPages)
  };
}

async function updateProjectAreaPassword(project, password) {
  if (!project || !project.id) {
    throw new Error("Project not found.");
  }

  const normalizedPassword = String(password || "");
  if (normalizedPassword.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const user = await resolveProjectUser(project);
  if (!user || !user.id) {
    throw new Error("No user found for this project.");
  }

  const passwordHash = hashPassword(normalizedPassword);
  const updated = await userRepository.updateUserPasswordHash(user.id, passwordHash);
  if (!updated) {
    throw new Error("Could not update password.");
  }

  return { email: updated.email };
}

async function sendProjectAreaPasswordUpdateEmail(project) {
  let email = String(project && project.customerEmail ? project.customerEmail : "").trim().toLowerCase();

  if (!email && project && project.userId) {
    const user = await userRepository.findUserById(project.userId);
    email = String(user && user.email ? user.email : "").trim().toLowerCase();
  }

  if (!email) {
    throw new Error("No customer email found for this project.");
  }

  const accessProject = await projectService.ensureProjectAccessToken(project);
  const baseUrl = String(process.env.BASE_URL || "https://wptoai.com").replace(/\/+$/, "");
  const link = `${baseUrl}/project-area?project=${encodeURIComponent(accessProject.id)}&token=${encodeURIComponent(accessProject.accessToken || "")}`;
  const subject = "Your WPtoAI access link";
  const html = `
    <p>Hi,</p>
    <p>Use this secure link to continue into your WPtoAI Project Area.</p>
    <p><a href="${link}">${link}</a></p>
    <p>— WPtoAI</p>
  `;
  await sendEmail(email, subject, html);
  return { email };
}

async function requestProjectAreaAccessLink(email, baseUrl) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    throw new Error("Enter a valid email to continue.");
  }

  console.log("ACCESS_LINK_REQUESTED", normalizedEmail);

  const user = await userRepository.findUserByEmail(normalizedEmail);
  let project = null;

  if (user && user.id) {
    project = await projectRepository.findLatestProjectByUserId(user.id);
  }

  if (!project) {
    project = await projectRepository.findLatestProjectByCustomerEmail(normalizedEmail);
  }

  if (!project || !project.id) {
    throw new Error("No project found for this email.");
  }

  const refreshedProject = await projectService.refreshProjectAccessToken(project);
  if (!refreshedProject || !refreshedProject.id || !refreshedProject.accessToken) {
    throw new Error("Could not generate a new access link.");
  }

  const normalizedBaseUrl = String(baseUrl || process.env.BASE_URL || "https://wptoai.com").replace(/\/+$/, "");
  const link =
    `${normalizedBaseUrl}/project-area?project=${encodeURIComponent(refreshedProject.id)}` +
    `&token=${encodeURIComponent(refreshedProject.accessToken)}`;
  const subject = "Your WPtoAI access link";
  const html = `
    <p>Hi,</p>
    <p>Use this secure link to continue into your WPtoAI Project Area.</p>
    <p>
      <a href="${link}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#3558c6;color:#ffffff;text-decoration:none;font-weight:600;">
        Open Project Area
      </a>
    </p>
    <p><a href="${link}">${link}</a></p>
    <p>— WPtoAI</p>
  `;

  await sendEmail(normalizedEmail, subject, html);
  console.log("ACCESS_LINK_SENT", normalizedEmail, refreshedProject.id);

  return {
    email: normalizedEmail,
    projectId: refreshedProject.id
  };
}

async function requestProjectAreaEmailUpdate(project, newEmail, baseUrl) {
  if (!project || !project.id) {
    throw new Error("Project not found.");
  }

  const normalizedEmail = normalizeEmail(newEmail);
  if (!isValidEmail(normalizedEmail)) {
    throw new Error("Enter a valid email address.");
  }

  const user = await resolveProjectUser(project);
  if (!user || !user.id) {
    throw new Error("No user found for this project.");
  }

  const currentEmail = normalizeEmail((user && user.email) || project.customerEmail || "");
  if (!currentEmail) {
    throw new Error("No customer email found for this project.");
  }
  if (normalizedEmail === currentEmail) {
    throw new Error("Enter a different email address.");
  }

  const existingUser = await userRepository.findUserByEmail(normalizedEmail);
  if (existingUser && existingUser.id !== user.id) {
    throw new Error("This email is already in use.");
  }

  const verificationToken = generateEmailUpdateToken();
  const expiresAt = computeEmailUpdateExpiry();
  await emailUpdateTokenRepository.deleteEmailUpdateTokensByProjectId(project.id);
  await emailUpdateTokenRepository.createEmailUpdateToken({
    projectId: project.id,
    newEmail: normalizedEmail,
    token: verificationToken,
    expiresAt
  });

  const normalizedBaseUrl = String(baseUrl || process.env.BASE_URL || "https://wptoai.com").replace(/\/+$/, "");
  const link = `${normalizedBaseUrl}/api/verify-email-update?token=${encodeURIComponent(verificationToken)}`;
  const subject = "Confirm your new WPtoAI email";
  const html = `
    <p>Hi,</p>
    <p>Confirm your new email to keep using your WPtoAI Project Area.</p>
    <p>
      <a href="${link}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#3558c6;color:#ffffff;text-decoration:none;font-weight:600;">
        Confirm new email
      </a>
    </p>
    <p><a href="${link}">${link}</a></p>
    <p>This secure link expires in 30 minutes.</p>
    <p>— WPtoAI</p>
  `;

  console.log("EMAIL_UPDATE_REQUESTED", project.id, normalizedEmail);
  await sendEmail(normalizedEmail, subject, html);

  return {
    email: normalizedEmail,
    projectId: project.id
  };
}

async function verifyProjectAreaEmailUpdate(token) {
  const verificationToken = String(token || "").trim();
  if (!verificationToken) {
    throw new Error("This email verification link is invalid or expired.");
  }

  const emailUpdateToken = await emailUpdateTokenRepository.findEmailUpdateTokenByToken(verificationToken);
  if (!emailUpdateToken || !emailUpdateToken.id) {
    throw new Error("This email verification link is invalid or expired.");
  }

  const expiresAt = emailUpdateToken.expiresAt ? new Date(emailUpdateToken.expiresAt).getTime() : 0;
  if (!expiresAt || expiresAt < Date.now()) {
    await emailUpdateTokenRepository.deleteEmailUpdateTokenById(emailUpdateToken.id);
    throw new Error("This email verification link is invalid or expired.");
  }

  const project = await projectRepository.findProjectById(emailUpdateToken.projectId);
  if (!project || !project.id) {
    await emailUpdateTokenRepository.deleteEmailUpdateTokenById(emailUpdateToken.id);
    throw new Error("This email verification link is invalid or expired.");
  }

  const user = await resolveProjectUser(project);
  if (!user || !user.id) {
    throw new Error("No user found for this project.");
  }

  const nextEmail = normalizeEmail(emailUpdateToken.newEmail);
  const existingUser = await userRepository.findUserByEmail(nextEmail);
  if (existingUser && existingUser.id !== user.id) {
    throw new Error("This email is already in use.");
  }

  await userRepository.updateUserEmail(user.id, nextEmail);
  const updatedProject = await projectRepository.updateProjectCustomerEmail(project.id, nextEmail);
  await emailUpdateTokenRepository.deleteEmailUpdateTokenById(emailUpdateToken.id);

  const refreshedProject = await projectService.refreshProjectAccessToken(updatedProject || project);
  if (!refreshedProject || !refreshedProject.id || !refreshedProject.accessToken) {
    throw new Error("Could not generate a new access link.");
  }

  console.log("EMAIL_UPDATE_VERIFIED", refreshedProject.id, nextEmail);

  return {
    projectId: refreshedProject.id,
    accessToken: refreshedProject.accessToken
  };
}

module.exports = {
  getProjectAreaData,
  createProjectAreaPage,
  deleteProjectAreaPage,
  processProjectAreaPage,
  renameProjectAreaPage,
  saveProjectAreaPageOrder,
  updateProjectAreaPassword,
  sendProjectAreaPasswordUpdateEmail,
  requestProjectAreaAccessLink,
  requestProjectAreaEmailUpdate,
  verifyProjectAreaEmailUpdate
};
