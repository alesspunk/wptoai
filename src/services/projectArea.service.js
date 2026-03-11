const crypto = require("crypto");
const { sendEmail } = require("./email.service");
const projectService = require("./project.service");
const quoteRepository = require("../repositories/quote.repository");
const projectRepository = require("../repositories/project.repository");
const projectPageRepository = require("../repositories/projectPage.repository");
const userRepository = require("../repositories/user.repository");

function mapProjectStatusToProgress(status) {
  switch (String(status || "").toLowerCase()) {
    case "ready":
      return 100;
    case "deploying":
      return 85;
    case "building":
      return 65;
    case "scanning":
      return 40;
    case "failed":
      return 5;
    case "queued":
    default:
      return 20;
  }
}

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

function buildDefaultPages({ project, quote }) {
  const siteUrl = normalizeSiteUrl(
    (project && project.wordpressUrl) ||
    (quote && quote.siteUrl) ||
    ""
  );
  let rootOrigin = "";
  try {
    rootOrigin = siteUrl ? new URL(siteUrl).origin : "";
  } catch (_error) {
    rootOrigin = "";
  }

  const detectedPages = deriveDetectedPages(quote);
  const previewImageUrl = String((quote && quote.previewImageUrl) || "");
  const list = [];
  list.push({
    title: "Homepage",
    url: rootOrigin || siteUrl || "",
    type: "homepage",
    parentId: null,
    status: "ready",
    screenshotUrl: previewImageUrl,
    orderIndex: 0
  });

  for (let index = 1; index < detectedPages; index += 1) {
    const readyByDefault = index <= 2 || String(project && project.status) === "ready";
    const slug = `page-${index + 1}`;
    const pageUrl = rootOrigin ? `${rootOrigin}/${slug}` : "";
    list.push({
      title: makeFallbackPageTitle(index),
      url: pageUrl,
      type: "page",
      parentId: null,
      status: readyByDefault ? "ready" : "processing",
      screenshotUrl: previewImageUrl,
      orderIndex: index
    });
  }

  return list;
}

function toApiPage(page) {
  return {
    id: page.id,
    title: page.title,
    url: page.url || "",
    type: page.type,
    parentId: page.parentId || null,
    persisted: true,
    status: page.status,
    screenshotUrl: page.screenshotUrl || "",
    orderIndex: Number(page.orderIndex || 0)
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

function toSummary({ project, quote, pages }) {
  const detectedPages = deriveDetectedPages(quote);
  const purchasedPages = derivePurchasedPages(quote, detectedPages);
  const usedPages = pages.filter((item) =>
    item.type === "homepage" || item.type === "page" || item.type === "section"
  ).length;
  const remainingPages = Math.max(0, purchasedPages - usedPages);

  return {
    projectId: project.id,
    status: project.status || "queued",
    wordpressUrl: project.wordpressUrl || "",
    customerEmail: project.customerEmail || "",
    migrationProgress: mapProjectStatusToProgress(project.status),
    detectedPages,
    purchasedPages,
    usedPages,
    remainingPages
  };
}

async function getProjectAreaData(project, selectedPageId) {
  const quote = project && project.quoteId
    ? await quoteRepository.findQuoteById(project.quoteId)
    : null;

  const seeded = await projectPageRepository.seedProjectPagesIfEmpty(
    project.id,
    buildDefaultPages({ project, quote })
  );
  const pages = (seeded || []).map(toApiPage);
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

module.exports = {
  getProjectAreaData,
  renameProjectAreaPage,
  saveProjectAreaPageOrder,
  updateProjectAreaPassword,
  sendProjectAreaPasswordUpdateEmail,
  requestProjectAreaAccessLink
};
