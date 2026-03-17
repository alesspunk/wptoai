const path = require("path");
const OpenAI = require("openai");

const WORKER_REQUIRED_PACKAGE_FILES = [
  "manifest.json",
  "build-config.json",
  "assets-manifest.json",
  "page-types.json",
  "project-summary.json",
  "approved-pages.json",
  "page-map.json",
  "sitemap.xml",
  "sitemap-readable.json",
  "brand-context.json",
  "README.md",
  "golden-prompt.md",
  "implementation-rules.md"
];

const AI_BUILD_MODEL = "gpt-4.1";
const RESERVED_BUILD_ASSET_PATHS = new Set([
  "assets/visual-reference-map.json"
]);
const AI_BUILD_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages", "css", "js", "assets"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "html"],
        properties: {
          path: { type: "string" },
          html: { type: "string" }
        }
      }
    },
    css: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        }
      }
    },
    js: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        }
      }
    },
    assets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "contentType"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          contentType: { type: "string" }
        }
      }
    }
  }
};

let openaiClient = null;

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(value, fallback) {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || String(fallback || "page");
}

function createTextFile(filePath, contentType, content) {
  return {
    path: filePath,
    contentType,
    content: String(content || "")
  };
}

function createJsonFile(filePath, value) {
  return createTextFile(filePath, "application/json", JSON.stringify(value, null, 2));
}

function readTextFile(files, fileName) {
  const file = files && files[fileName] ? files[fileName] : null;
  return String(file && file.content ? file.content : "");
}

function parseJsonFile(files, fileName, errors) {
  const file = files && files[fileName] ? files[fileName] : null;
  if (!file || !String(file.content || "").trim()) {
    errors.push({
      code: "missing_file",
      file: fileName,
      message: `${fileName} is missing from the build package.`
    });
    return null;
  }

  try {
    return JSON.parse(String(file.content || ""));
  } catch (_error) {
    errors.push({
      code: "invalid_json",
      file: fileName,
      message: `${fileName} is not valid JSON.`
    });
    return null;
  }
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  return openaiClient;
}

function stripJsonCodeFence(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("```")) return text;
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function normalizeBuildPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^build\/+/, "")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function assertSafeBuildPath(filePath, expectedPrefix) {
  const normalizedPath = normalizeBuildPath(filePath);
  if (!normalizedPath) {
    throw new Error("AI build output contained an empty file path.");
  }
  if (normalizedPath.indexOf("..") >= 0) {
    throw new Error(`AI build output path "${normalizedPath}" is not allowed.`);
  }
  if (expectedPrefix && !normalizedPath.startsWith(expectedPrefix)) {
    throw new Error(`AI build output path "${normalizedPath}" must be inside ${expectedPrefix}.`);
  }
  return normalizedPath;
}

function getContentTypeForPath(filePath) {
  const normalizedPath = normalizeBuildPath(filePath).toLowerCase();
  if (normalizedPath.endsWith(".html")) return "text/html; charset=utf-8";
  if (normalizedPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (normalizedPath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (normalizedPath.endsWith(".json")) return "application/json";
  if (normalizedPath.endsWith(".svg")) return "image/svg+xml";
  if (normalizedPath.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (normalizedPath.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function extractResponseText(response) {
  if (response && typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  if (!response || !Array.isArray(response.output)) {
    return "";
  }

  const chunks = [];
  response.output.forEach((item) => {
    if (!item || !Array.isArray(item.content)) return;
    item.content.forEach((content) => {
      if (!content) return;
      if (typeof content.text === "string" && content.text.trim()) {
        chunks.push(content.text);
      }
    });
  });

  return chunks.join("\n").trim();
}

function traverseTree(nodes, visitor) {
  const items = Array.isArray(nodes) ? nodes : [];
  items.forEach((node) => {
    visitor(node);
    if (Array.isArray(node && node.children)) {
      traverseTree(node.children, visitor);
    }
  });
}

function collectDescendantLinks(node, outputPaths) {
  const links = [];
  traverseTree(Array.isArray(node && node.children) ? node.children : [], (child) => {
    if (!child || (child.type !== "homepage" && child.type !== "page")) return;
    const href = outputPaths.get(child.id) || "";
    if (!href) return;
    links.push({
      id: child.id,
      title: child.title || "Untitled",
      href
    });
  });
  return links;
}

function collectTreeOrder(tree, pageById) {
  const ordered = [];
  const seen = new Set();

  traverseTree(tree, (node) => {
    if (!node || !node.id) return;
    if (node.type !== "homepage" && node.type !== "page") return;
    if (seen.has(node.id)) return;
    const page = pageById.get(node.id);
    if (!page) return;
    seen.add(node.id);
    ordered.push(page);
  });

  return ordered;
}

function inferPageSummary(page, siteTitle, sectionTitles) {
  const type = String(page && page.pageType ? page.pageType : page && page.type ? page.type : "other").toLowerCase();
  const sectionLabel = sectionTitles.length ? ` within ${sectionTitles.join(" / ")}` : "";

  if (type === "homepage") {
    return `A clean static rebuild of ${siteTitle}, preserving the approved navigation, hierarchy, and brand direction.`;
  }
  if (type === "services") {
    return `This page organizes the approved service content for ${siteTitle}${sectionLabel} with a clear, conversion-friendly layout.`;
  }
  if (type === "contact") {
    return `This page supports a direct conversation path for ${siteTitle}${sectionLabel} using the approved structure and visual references.`;
  }
  if (type === "listing") {
    return `This page presents a browsable overview for ${siteTitle}${sectionLabel} while staying aligned with the approved sitemap.`;
  }
  if (type === "content") {
    return `This page carries structured informational content for ${siteTitle}${sectionLabel} using the approved page map and hierarchy.`;
  }
  return `This page is part of the approved ${siteTitle} sitemap${sectionLabel} and keeps the final hierarchy intact.`;
}

function normalizeColor(value) {
  const color = String(value || "").trim();
  if (!color) return "";
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  return "";
}

function buildTheme(brandContext) {
  const colors = Array.isArray(brandContext && brandContext.mainColors)
    ? brandContext.mainColors.map(normalizeColor).filter(Boolean)
    : [];

  return {
    accent: colors[0] || "#1d5f73",
    accentSoft: colors[1] || "#dbeaf0",
    background: "#f6f3ee",
    surface: "#fffdf9",
    surfaceAlt: "#edf2f4",
    text: "#1d2430",
    muted: "#5d6675",
    border: "#d7dde4"
  };
}

function buildOutputPaths(routablePages, pageMapById, approvedPagesById, homePageId) {
  const outputPaths = new Map();
  const usedSlugs = new Set();

  routablePages.forEach((page) => {
    if (page.id === homePageId) {
      outputPaths.set(page.id, "index.html");
      return;
    }

    const pageMap = pageMapById.get(page.id) || null;
    const sectionTitles = Array.isArray(pageMap && pageMap.sectionAncestorIds)
      ? pageMap.sectionAncestorIds
        .map((id) => approvedPagesById.get(id))
        .filter(Boolean)
        .map((section) => section.title)
      : [];
    const baseSlug = slugify(sectionTitles.concat(page.title || page.id).join("-"), page.id);
    let uniqueSlug = baseSlug;
    let counter = 2;

    while (usedSlugs.has(uniqueSlug)) {
      uniqueSlug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    usedSlugs.add(uniqueSlug);
    outputPaths.set(page.id, `pages/${uniqueSlug}.html`);
  });

  return outputPaths;
}

function toRelativeHref(fromPath, toPath) {
  const fromDir = path.posix.dirname(fromPath);
  const relative = path.posix.relative(fromDir, toPath);
  return relative || path.posix.basename(toPath);
}

function buildTopLevelNavigation(tree, outputPaths) {
  return (Array.isArray(tree) ? tree : []).map((node) => {
    if (!node) return null;

    if (node.type === "homepage" || node.type === "page") {
      return {
        id: node.id,
        title: node.title || "Untitled",
        type: node.type,
        href: outputPaths.get(node.id) || "",
        children: []
      };
    }

    if (node.type === "section") {
      return {
        id: node.id,
        title: node.title || "Section",
        type: "section",
        href: "",
        children: collectDescendantLinks(node, outputPaths)
      };
    }

    return null;
  }).filter(Boolean);
}

function renderNavigation(navItems, currentPageId, currentFilePath) {
  const itemsHtml = navItems.map((item) => {
    if (item.type === "section") {
      const children = item.children.map((child) => {
        const href = toRelativeHref(currentFilePath, child.href);
        const isCurrent = child.id === currentPageId ? ' aria-current="page"' : "";
        return `<li><a href="${escapeHtml(href)}"${isCurrent}>${escapeHtml(child.title)}</a></li>`;
      }).join("");
      return [
        '<li class="site-nav__group">',
        `<details${children.indexOf('aria-current="page"') >= 0 ? " open" : ""}>`,
        `<summary>${escapeHtml(item.title)}</summary>`,
        `<ul class="site-nav__sublist">${children}</ul>`,
        "</details>",
        "</li>"
      ].join("");
    }

    const href = toRelativeHref(currentFilePath, item.href);
    const isCurrent = item.id === currentPageId ? ' aria-current="page"' : "";
    return `<li><a href="${escapeHtml(href)}"${isCurrent}>${escapeHtml(item.title)}</a></li>`;
  }).join("");

  return `<nav class="site-nav" aria-label="Primary"><ul>${itemsHtml}</ul></nav>`;
}

function renderBreadcrumb(page, sectionTitles, currentFilePath, isHomepage) {
  const parts = [
    `<a href="${escapeHtml(toRelativeHref(currentFilePath, "index.html"))}">Home</a>`
  ];

  sectionTitles.forEach((sectionTitle) => {
    parts.push(`<span>${escapeHtml(sectionTitle)}</span>`);
  });

  if (!isHomepage) {
    parts.push(`<span aria-current="page">${escapeHtml(page.title || "Untitled")}</span>`);
  }

  return `<nav class="breadcrumb" aria-label="Breadcrumb">${parts.join("<span class=\"breadcrumb__sep\">/</span>")}</nav>`;
}

function renderPageCards(title, cards, currentFilePath) {
  if (!Array.isArray(cards) || !cards.length) return "";

  const cardsHtml = cards.map((card) => {
    const href = card.href ? toRelativeHref(currentFilePath, card.href) : "";
    const linkHtml = href
      ? `<a class="card-link" href="${escapeHtml(href)}">Open page</a>`
      : "";
    return [
      '<article class="info-card">',
      `<h3>${escapeHtml(card.title || "Untitled")}</h3>`,
      card.summary ? `<p>${escapeHtml(card.summary)}</p>` : "",
      linkHtml,
      "</article>"
    ].join("");
  }).join("");

  return [
    '<section class="content-section">',
    `<div class="section-heading"><p class="eyebrow">${escapeHtml(title)}</p></div>`,
    `<div class="card-grid">${cardsHtml}</div>`,
    "</section>"
  ].join("");
}

function renderReferencePanel(asset, pageTitle) {
  if (!asset) return "";

  if (asset.sourceUrl) {
    return [
      '<section class="content-section reference-panel">',
      '<div class="section-heading"><p class="eyebrow">Approved visual reference</p></div>',
      '<figure class="reference-figure">',
      `<img src="${escapeHtml(asset.sourceUrl)}" alt="${escapeHtml(`Approved screenshot reference for ${pageTitle}`)}" loading="lazy">`,
      `<figcaption>Package reference: ${escapeHtml(asset.logicalPath || "")}</figcaption>`,
      "</figure>",
      "</section>"
    ].join("");
  }

  return [
    '<section class="content-section reference-panel">',
    '<div class="section-heading"><p class="eyebrow">Approved visual reference</p></div>',
    '<div class="reference-placeholder">',
    `<p>${escapeHtml(pageTitle)} has an approved screenshot reference stored as package metadata.</p>`,
    `<p>Logical path: ${escapeHtml(asset.logicalPath || "")}</p>`,
    "</div>",
    "</section>"
  ].join("");
}

function renderPageHero(page, siteTitle, summary, sectionTitles, isHomepage) {
  const metaLine = sectionTitles.length
    ? sectionTitles.join(" / ")
    : (isHomepage ? siteTitle : "Approved page");

  return [
    '<section class="hero">',
    `<p class="eyebrow">${escapeHtml(metaLine)}</p>`,
    `<h1>${escapeHtml(isHomepage ? siteTitle : (page.title || "Untitled"))}</h1>`,
    `<p class="hero-copy">${escapeHtml(summary)}</p>`,
    "</section>"
  ].join("");
}

function renderHomepageOverview(context, currentFilePath) {
  const topLevelCards = context.navigation.map((item) => ({
    title: item.title,
    summary: item.type === "section"
      ? `${item.children.length} approved page${item.children.length === 1 ? "" : "s"} in this section.`
      : "Approved top-level page in the final sitemap.",
    href: item.type === "section" || !item.href ? "" : item.href
  }));

  const featuredPages = context.orderedPages
    .filter((page) => page.id !== context.homePageId)
    .slice(0, 6)
    .map((page) => {
      const asset = context.assetsByPageId.get(page.id) || null;
      return {
        title: page.title,
        summary: asset && asset.sourceUrl
          ? "Includes an approved screenshot reference from the package."
          : "Structured from the approved page map and hierarchy.",
        href: context.outputPaths.get(page.id)
      };
    });

  return [
    renderPageCards("Approved sitemap", topLevelCards, currentFilePath),
    renderPageCards("Featured pages", featuredPages, currentFilePath)
  ].join("");
}

function renderRelatedContent(relatedPages, currentFilePath) {
  if (!Array.isArray(relatedPages) || !relatedPages.length) return "";
  return renderPageCards(
    "Related pages",
    relatedPages.map((page) => ({
      title: page.title,
      summary: page.summary,
      href: page.href
    })),
    currentFilePath
  );
}

function buildHtmlDocument(options) {
  const navHtml = renderNavigation(options.navigation, options.page.id, options.currentFilePath);
  const breadcrumbHtml = renderBreadcrumb(
    options.page,
    options.sectionTitles,
    options.currentFilePath,
    options.isHomepage
  );
  const pageHero = renderPageHero(
    options.page,
    options.siteTitle,
    options.pageSummary,
    options.sectionTitles,
    options.isHomepage
  );
  const overviewHtml = options.isHomepage
    ? renderHomepageOverview(options.context, options.currentFilePath)
    : "";
  const referenceHtml = renderReferencePanel(options.asset, options.page.title || options.siteTitle);
  const relatedHtml = renderRelatedContent(options.relatedPages, options.currentFilePath);

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(options.documentTitle)}</title>`,
    options.metaDescription
      ? `  <meta name="description" content="${escapeHtml(options.metaDescription)}">`
      : "",
    `  <link rel="stylesheet" href="${escapeHtml(toRelativeHref(options.currentFilePath, "css/site.css"))}">`,
    "</head>",
    "<body>",
    '<div class="site-shell">',
    "<header class=\"site-header\">",
    `<a class="brand-mark" href="${escapeHtml(toRelativeHref(options.currentFilePath, "index.html"))}">${escapeHtml(options.siteTitle)}</a>`,
    navHtml,
    "</header>",
    '<main class="site-main">',
    breadcrumbHtml,
    pageHero,
    overviewHtml,
    referenceHtml,
    relatedHtml,
    "</main>",
    '<footer class="site-footer">',
    `<p>${escapeHtml(options.siteTitle)} static preview build</p>`,
    `<p>${escapeHtml(options.footerText)}</p>`,
    "</footer>",
    "</div>",
    "</body>",
    "</html>"
  ].filter(Boolean).join("\n");
}

function buildCss(theme) {
  return `
:root {
  --bg: ${theme.background};
  --surface: ${theme.surface};
  --surface-alt: ${theme.surfaceAlt};
  --text: ${theme.text};
  --muted: ${theme.muted};
  --border: ${theme.border};
  --accent: ${theme.accent};
  --accent-soft: ${theme.accentSoft};
  --shadow: 0 22px 60px rgba(18, 26, 38, 0.08);
  --radius-lg: 28px;
  --radius-md: 18px;
  --max-width: 1120px;
}

* {
  box-sizing: border-box;
}

html {
  color-scheme: light;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at top left, rgba(255, 255, 255, 0.85), transparent 34%),
    linear-gradient(180deg, #f9f6f1 0%, var(--bg) 100%);
  color: var(--text);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
  line-height: 1.6;
}

a {
  color: inherit;
}

img {
  max-width: 100%;
  display: block;
}

.site-shell {
  width: min(100%, var(--max-width));
  margin: 0 auto;
  padding: 32px 20px 64px;
}

.site-header,
.site-footer,
.hero,
.content-section,
.reference-panel {
  border: 1px solid rgba(0, 0, 0, 0.04);
  background: rgba(255, 253, 249, 0.92);
  box-shadow: var(--shadow);
  border-radius: var(--radius-lg);
}

.site-header,
.site-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 24px;
}

.brand-mark {
  text-decoration: none;
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: 1.25rem;
  letter-spacing: 0.03em;
}

.site-nav ul,
.site-nav__sublist {
  list-style: none;
  margin: 0;
  padding: 0;
}

.site-nav > ul {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
}

.site-nav a,
.site-nav summary {
  color: var(--muted);
  cursor: pointer;
  text-decoration: none;
}

.site-nav a[aria-current="page"] {
  color: var(--accent);
  font-weight: 600;
}

.site-nav details {
  position: relative;
}

.site-nav__sublist {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  min-width: 220px;
  padding: 14px;
  display: grid;
  gap: 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow);
  z-index: 2;
}

.site-main {
  display: grid;
  gap: 24px;
  padding: 28px 0;
}

.breadcrumb {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--muted);
  font-size: 0.95rem;
}

.breadcrumb a {
  text-decoration: none;
}

.breadcrumb__sep {
  opacity: 0.5;
}

.hero,
.content-section,
.reference-panel {
  padding: 28px;
}

.eyebrow {
  margin: 0 0 14px;
  font-size: 0.82rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
}

.hero h1 {
  margin: 0;
  font-family: "Iowan Old Style", "Palatino Linotype", serif;
  font-size: clamp(2.5rem, 4vw, 4.5rem);
  line-height: 0.98;
}

.hero-copy {
  margin: 18px 0 0;
  max-width: 64ch;
  font-size: 1.08rem;
  color: var(--muted);
}

.section-heading {
  margin-bottom: 18px;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 18px;
}

.info-card {
  padding: 20px;
  border-radius: var(--radius-md);
  background: linear-gradient(180deg, #ffffff 0%, rgba(237, 242, 244, 0.75) 100%);
  border: 1px solid var(--border);
}

.info-card h3 {
  margin: 0 0 10px;
  font-size: 1.1rem;
}

.info-card p {
  margin: 0;
  color: var(--muted);
}

.card-link {
  display: inline-flex;
  margin-top: 14px;
  text-decoration: none;
  color: var(--accent);
  font-weight: 600;
}

.reference-figure {
  display: grid;
  gap: 12px;
}

.reference-figure img {
  width: 100%;
  border-radius: 22px;
  border: 1px solid var(--border);
  background: var(--surface-alt);
}

.reference-figure figcaption,
.reference-placeholder p,
.site-footer p {
  margin: 0;
  color: var(--muted);
}

.reference-placeholder {
  padding: 22px;
  border-radius: var(--radius-md);
  border: 1px dashed var(--border);
  background: var(--surface-alt);
}

@media (max-width: 760px) {
  .site-shell {
    padding: 18px 14px 40px;
  }

  .site-header,
  .site-footer {
    flex-direction: column;
    align-items: flex-start;
  }

  .site-nav > ul {
    flex-direction: column;
    align-items: flex-start;
  }

  .site-nav__sublist {
    position: static;
    min-width: 0;
    margin-top: 10px;
    width: 100%;
  }

  .hero,
  .content-section,
  .reference-panel {
    padding: 22px;
  }
}
  `.trim();
}

function buildReadmeBuild(context, buildLog) {
  return [
    "# WPtoAI Build Output",
    "",
    `Project: \`${context.manifest.project_id || context.projectId}\``,
    `Job: \`${buildLog.jobId}\``,
    `Provider: \`${buildLog.providerUsed}\``,
    `Started: \`${buildLog.startedAt}\``,
    "",
    "This build was generated from the approved package bundle without rescanning the source site.",
    "",
    "## Source of truth",
    "- Pages: `approved-pages.json` from the package",
    "- Hierarchy: `sitemap-readable.json` and `sitemap.xml` from the package",
    "- Visual mapping: `page-map.json` and `assets-manifest.json` from the package",
    "- Branding: `brand-context.json` from the package",
    "",
    "## Output structure",
    "- `build/index.html`",
    "- `build/pages/*.html`",
    "- `build/css/site.css`",
    "- `build/assets/visual-reference-map.json`",
    "- `build/build-log.json`"
  ].join("\n");
}

function buildContextFromValidatedPackage(validated) {
  const approvedPages = validated.approvedPages;
  const approvedPagesById = new Map();
  approvedPages.forEach((page) => {
    approvedPagesById.set(page.id, page);
  });

  const pageTypesById = new Map();
  (validated.pageTypes.pages || []).forEach((pageType) => {
    pageTypesById.set(pageType.pageId, String(pageType.pageType || "other"));
  });

  const pageMapById = new Map();
  (validated.pageMap.pageMappings || []).forEach((mapping) => {
    pageMapById.set(mapping.pageId, mapping);
  });

  const assetsByLogicalPath = new Map();
  const assetsByPageId = new Map();
  (validated.assetsManifest.assets || []).forEach((asset) => {
    if (asset.logicalPath) {
      assetsByLogicalPath.set(asset.logicalPath, asset);
    }
    if (asset.pageId) {
      assetsByPageId.set(asset.pageId, asset);
    }
  });

  const routablePages = approvedPages.filter((page) => page.type === "homepage" || page.type === "page");
  const orderedFromTree = collectTreeOrder(validated.sitemapReadable.tree || [], approvedPagesById);
  const seenIds = new Set(orderedFromTree.map((page) => page.id));
  const fallbackPages = routablePages
    .filter((page) => !seenIds.has(page.id))
    .sort((a, b) => Number(a.orderIndex || 0) - Number(b.orderIndex || 0));

  const homepage = routablePages.find((page) => page.type === "homepage") || orderedFromTree[0] || fallbackPages[0];
  const orderedPages = [];

  if (homepage) {
    orderedPages.push(homepage);
  }

  orderedFromTree.forEach((page) => {
    if (!page || (homepage && page.id === homepage.id)) return;
    orderedPages.push(page);
  });

  fallbackPages.forEach((page) => {
    if (!page || orderedPages.find((item) => item.id === page.id)) return;
    orderedPages.push(page);
  });

  const homePageId = homepage ? homepage.id : "";
  const outputPaths = buildOutputPaths(orderedPages, pageMapById, approvedPagesById, homePageId);
  const navigation = buildTopLevelNavigation(validated.sitemapReadable.tree || [], outputPaths);

  return {
    projectId: validated.manifest.project_id || validated.bundle.projectId || "",
    quoteId: validated.manifest.quote_id || validated.bundle.quoteId || null,
    manifest: validated.manifest,
    buildConfig: validated.buildConfig,
    assetsManifest: validated.assetsManifest,
    projectSummary: validated.projectSummary,
    brandContext: validated.brandContext || {},
    approvedPages,
    approvedPagesById,
    pageTypesById,
    pageMapById,
    assetsByLogicalPath,
    assetsByPageId,
    outputPaths,
    navigation,
    orderedPages,
    homePageId,
    siteTitle: normalizeWhitespace(
      (validated.projectSummary && validated.projectSummary.siteTitle) ||
      (validated.brandContext && validated.brandContext.siteTitle) ||
      (validated.manifest && validated.manifest.source_domain) ||
      "WPtoAI Site"
    ),
    siteDescription: normalizeWhitespace(
      (validated.projectSummary && validated.projectSummary.siteDescription) ||
      (validated.brandContext && validated.brandContext.visualIdentityNotes && validated.brandContext.visualIdentityNotes[0]) ||
      ""
    )
  };
}

function validateWorkerPackageBundle(bundle) {
  const errors = [];
  const warnings = [];
  const files = bundle && bundle.files && typeof bundle.files === "object" ? bundle.files : {};

  WORKER_REQUIRED_PACKAGE_FILES.forEach((fileName) => {
    const file = files[fileName];
    if (!file || !String(file.content || "").trim()) {
      errors.push({
        code: "missing_file",
        file: fileName,
        message: `${fileName} is required by the build worker.`
      });
    }
  });

  const manifest = parseJsonFile(files, "manifest.json", errors);
  const buildConfig = parseJsonFile(files, "build-config.json", errors);
  const assetsManifest = parseJsonFile(files, "assets-manifest.json", errors);
  const pageTypes = parseJsonFile(files, "page-types.json", errors);
  const projectSummary = parseJsonFile(files, "project-summary.json", errors);
  const approvedPagesPayload = parseJsonFile(files, "approved-pages.json", errors);
  const pageMap = parseJsonFile(files, "page-map.json", errors);
  const sitemapReadable = parseJsonFile(files, "sitemap-readable.json", errors);
  const brandContext = parseJsonFile(files, "brand-context.json", errors);
  const sitemapXml = readTextFile(files, "sitemap.xml");
  const readme = readTextFile(files, "README.md");
  const goldenPrompt = readTextFile(files, "golden-prompt.md");
  const implementationRules = readTextFile(files, "implementation-rules.md");

  const approvedPages = approvedPagesPayload && Array.isArray(approvedPagesPayload.pages)
    ? approvedPagesPayload.pages
    : [];

  if (!approvedPages.length) {
    errors.push({
      code: "empty_approved_pages",
      file: "approved-pages.json",
      message: "The build package must include at least one approved page."
    });
  }

  const routablePages = approvedPages.filter((page) => page && (page.type === "homepage" || page.type === "page"));
  if (!routablePages.length) {
    errors.push({
      code: "missing_routable_pages",
      file: "approved-pages.json",
      message: "The build package must include at least one routable page."
    });
  }

  const tree = sitemapReadable && Array.isArray(sitemapReadable.tree) ? sitemapReadable.tree : [];
  if (!tree.length) {
    errors.push({
      code: "empty_hierarchy",
      file: "sitemap-readable.json",
      message: "The build package hierarchy is empty."
    });
  }

  if (!String(sitemapXml || "").trim() || sitemapXml.indexOf("<urlset") === -1) {
    errors.push({
      code: "invalid_sitemap",
      file: "sitemap.xml",
      message: "sitemap.xml is missing or invalid."
    });
  }

  if (manifest) {
    if (!String(manifest.package_version || "").trim()) {
      errors.push({
        code: "missing_package_version",
        file: "manifest.json",
        message: "manifest.json is missing package_version."
      });
    }
    if (!String(manifest.schema_version || "").trim()) {
      errors.push({
        code: "missing_schema_version",
        file: "manifest.json",
        message: "manifest.json is missing schema_version."
      });
    }
  }

  if (buildConfig && String(buildConfig.targetOutput || "").trim().toLowerCase() !== "static-html-css-js") {
    warnings.push({
      code: "unexpected_target_output",
      file: "build-config.json",
      message: "build-config.json targetOutput is not the expected static HTML/CSS/JS value."
    });
  }

  if (!brandContext) {
    warnings.push({
      code: "missing_brand_context",
      file: "brand-context.json",
      message: "brand-context.json is missing. The worker will fall back to a neutral theme."
    });
  }

  const assets = assetsManifest && Array.isArray(assetsManifest.assets) ? assetsManifest.assets : [];
  const assetPaths = new Set();
  assets.forEach((asset, index) => {
    const logicalPath = String(asset && asset.logicalPath ? asset.logicalPath : "").trim();
    if (!logicalPath) {
      warnings.push({
        code: "missing_asset_path",
        file: "assets-manifest.json",
        message: `Asset at index ${index} is missing logicalPath.`
      });
      return;
    }
    assetPaths.add(logicalPath);
  });

  const mappings = pageMap && Array.isArray(pageMap.pageMappings) ? pageMap.pageMappings : [];
  mappings.forEach((mapping) => {
    const screenshotAssetPath = String(mapping && mapping.screenshotAssetPath ? mapping.screenshotAssetPath : "").trim();
    if (screenshotAssetPath && !assetPaths.has(screenshotAssetPath)) {
      errors.push({
        code: "invalid_page_map_asset",
        file: "page-map.json",
        message: `Page map entry "${mapping.pageId || "unknown"}" references a missing asset path.`
      });
    }
  });

  return {
    validationStatus: errors.length ? "failed" : "valid",
    errors,
    warnings,
    bundle,
    manifest,
    buildConfig,
    assetsManifest: assetsManifest || { assets: [] },
    pageTypes: pageTypes || { pages: [] },
    projectSummary: projectSummary || {},
    approvedPages,
    pageMap: pageMap || { pageMappings: [] },
    sitemapReadable: sitemapReadable || { tree: [] },
    brandContext,
    sitemapXml,
    readme,
    goldenPrompt,
    implementationRules
  };
}

function buildAiOutputPlan(context) {
  return context.orderedPages.map((page) => {
    const currentFilePath = context.outputPaths.get(page.id);
    const pageMap = context.pageMapById.get(page.id) || null;
    const sectionTitles = Array.isArray(pageMap && pageMap.sectionAncestorIds)
      ? pageMap.sectionAncestorIds
        .map((sectionId) => context.approvedPagesById.get(sectionId))
        .filter(Boolean)
        .map((section) => section.title)
      : [];
    const asset = pageMap && pageMap.screenshotAssetPath
      ? context.assetsByLogicalPath.get(pageMap.screenshotAssetPath) || null
      : (context.assetsByPageId.get(page.id) || null);
    const isHomepage = page.id === context.homePageId;
    const pageType = isHomepage
      ? "homepage"
      : (context.pageTypesById.get(page.id) || page.type || "other");

    return {
      pageId: page.id,
      title: page.title || "Untitled",
      pageType,
      path: currentFilePath,
      isHomepage,
      parentId: page.parentId || null,
      orderIndex: Number(page.orderIndex || 0),
      priority: String(page.priority || "normal"),
      sectionTitles,
      status: String(page.status || ""),
      summary: inferPageSummary(
        { ...page, pageType },
        context.siteTitle,
        sectionTitles
      ),
      screenshot: asset ? {
        logicalPath: asset.logicalPath || "",
        sourceUrl: asset.sourceUrl || "",
        sourceRef: asset.sourceRef || null
      } : null
    };
  }).filter((page) => page.path);
}

function buildPageLinkPlan(outputPlan) {
  return outputPlan.map((page) => ({
    pageId: page.pageId,
    currentPath: page.path,
    homeHref: toRelativeHref(page.path, "index.html"),
    links: outputPlan.map((target) => ({
      pageId: target.pageId,
      title: target.title,
      path: target.path,
      href: toRelativeHref(page.path, target.path)
    }))
  }));
}

function buildAiPromptContext(validatedBundle, context, outputPlan) {
  return {
    sourceOfTruth: {
      pages: "approved-pages.json",
      hierarchy: "sitemap-readable.json and sitemap.xml",
      pageScreenshotMapping: "page-map.json",
      branding: "brand-context.json",
      assets: "assets-manifest.json",
      buildInstructions: "golden-prompt.md",
      implementationRules: "implementation-rules.md"
    },
    manifest: validatedBundle.manifest,
    buildConfig: validatedBundle.buildConfig,
    projectSummary: validatedBundle.projectSummary,
    approvedPages: validatedBundle.approvedPages,
    sitemapReadable: validatedBundle.sitemapReadable,
    sitemapXml: validatedBundle.sitemapXml,
    pageMap: validatedBundle.pageMap,
    brandContext: validatedBundle.brandContext || {},
    assetsManifest: validatedBundle.assetsManifest,
    readme: validatedBundle.readme,
    goldenPrompt: validatedBundle.goldenPrompt,
    implementationRules: validatedBundle.implementationRules,
    siteContext: {
      siteTitle: context.siteTitle,
      siteDescription: context.siteDescription,
      navigation: context.navigation,
      orderedPageIds: outputPlan.map((page) => page.pageId)
    },
    outputPlan: {
      pages: outputPlan,
      cssFiles: ["css/site.css"],
      jsDirectory: "js/",
      assetsDirectory: "assets/",
      pageLinks: buildPageLinkPlan(outputPlan)
    }
  };
}

function buildAiInstructions(validatedBundle, outputPlan) {
  const expectedPaths = outputPlan.map((page) => page.path).join(", ");
  return [
    "You are a senior frontend engineer specialized in reconstructing production websites from visual and structural inputs.",
    "Your task is to rebuild a website using page structure data, extracted content, screenshots (visual reference), and assets (images, logos if available).",
    "IMPORTANT: You are NOT designing a new site. You are reconstructing an existing one with high fidelity.",
    "",
    "PRIMARY GOAL",
    "Recreate the layout, structure, and visual hierarchy of the original site as accurately as possible using static HTML + CSS.",
    "",
    "VISUAL FIDELITY RULES (CRITICAL)",
    "1. Match layout before aesthetics: respect section order exactly, preserve spacing relationships, and do not reorganize content.",
    "2. Recreate hierarchy exactly: headings must reflect original importance and content must not be promoted or demoted arbitrarily.",
    "3. Preserve spacing and alignment: maintain visual spacing proportions, alignment, column structure, and grouping.",
    "4. Sections must match the screenshot structure: hero, features, content blocks, CTA sections, footer. Do not omit sections.",
    "",
    "CONTENT RULES",
    "Use the exact provided text when available. Do not rewrite content, do not generate new marketing copy, and preserve tone and structure.",
    "",
    "IMAGES & ASSETS",
    "Use provided assets when available. If something is missing, use a placeholder only to preserve layout. Do not invent random images, and keep image placement consistent with the screenshots.",
    "",
    "SCREENSHOT REFERENCES",
    "Screenshots are visual reference inputs only. Use them to understand layout, spacing, hierarchy, and styling.",
    "Do not render screenshot reference files as visible content in the final website.",
    "Do not emit <img> tags, picture sources, CSS backgrounds, or other visible elements that point to assets/screenshots/* unless a screenshot asset is explicitly approved as a real site asset, which is not the default behavior.",
    "Convert screenshot observations into reconstructed HTML/CSS sections instead of embedding the screenshot itself.",
    "The final website must be a reconstructed static site, not a screenshot viewer. If a page cannot be reconstructed perfectly, prefer a simple structural approximation of the visible layout instead of displaying the screenshot.",
    "Do not generate screenshot frames, screenshot cards, screenshot captions, screenshot labels, or approval/reference callouts such as 'homepage screenshot', 'approved snapshot', 'reference screenshot', 'approved homepage reference', or similar wording.",
    "Do not generate customer-facing copy that explains the screenshot, the rebuild process, or that the page was reconstructed from visual references.",
    "Do not produce pages whose main visible content is a screenshot frame, image placeholder, reference card, or explanatory artifact.",
    "Reconstruct real page sections such as header/navigation, hero, content sections, grids, CTAs, and footer whenever they are visible in the screenshots or implied by the approved page structure.",
    "Prefer a simple but real section-by-section rebuild over any screenshot-based placeholder composition.",
    "",
    "TYPOGRAPHY",
    "Use system fonts such as Arial, sans-serif. Approximate font sizes visually, preserve hierarchy contrast, and do not import external fonts.",
    "",
    "COLORS",
    "Approximate colors from the screenshots, prioritize contrast and readability, and keep color usage consistent across sections.",
    "",
    "CSS STRUCTURE",
    "Create a single shared stylesheet at css/site.css. Use clean readable class names, prefer simple flexbox/grid layouts, and avoid over-engineering.",
    "",
    "HTML STRUCTURE",
    "Use semantic HTML such as header, section, and footer. Keep each section clearly separated and maintain logical grouping of elements.",
    "",
    "JAVASCRIPT",
    "Do not include JavaScript unless strictly necessary. No frameworks and no unnecessary interactivity.",
    "",
    "RESPONSIVENESS (LIGHT)",
    "Ensure layouts stack properly on mobile with simple responsive rules. Do not over-optimize.",
    "",
    "STRICT PROHIBITIONS",
    "Do not redesign the site, improve UX, change layout, remove sections, add sections, use React or Next.js, or add animations and unnecessary effects.",
    "",
    "SUCCESS DEFINITION",
    "The output should visually resemble the original layout, preserve structure and content, remain clean and readable, and be deployable as static HTML.",
    "",
    "OUTPUT FORMAT",
    "Return JSON only and make it match the provided schema exactly.",
    "Use the package files as the sole source of truth for pages, hierarchy, navigation, branding, and assets.",
    "Generate one complete HTML document for each page path in outputPlan.pages.",
    "Use semantic HTML, accessible headings, and relative links based on outputPlan.pageLinks.",
    "Create a shared stylesheet at css/site.css.",
    "Only create JavaScript files when they are genuinely necessary, and keep them in js/.",
    "Only create text-based assets such as SVG, JSON, or TXT in assets/. Do not emit binary image data.",
    "Do not emit files under assets/screenshots/. Those screenshot paths are existing package references, not generated build assets.",
    "Do not emit final HTML that renders assets/screenshots/* as visible page content, hero images, placeholders, or fallback content.",
    "Do not emit final HTML that behaves like a screenshot viewer, approval artifact, visual-reference card, or mock preview instead of a real reconstructed website.",
    "Do not invent extra pages, routes, navigation items, sections, screenshots, or branding elements.",
    "Do not add WordPress runtime dependencies, React, Next.js, or heavy libraries.",
    "Respect the approved hierarchy, screenshot mappings, golden prompt, and implementation rules.",
    "Remember: you are not a designer. You are reconstructing a real website with discipline and precision.",
    `Expected page paths: ${expectedPaths || "index.html"}`,
    "",
    "golden-prompt.md:",
    String(validatedBundle.goldenPrompt || "").trim() || "(empty)",
    "",
    "implementation-rules.md:",
    String(validatedBundle.implementationRules || "").trim() || "(empty)"
  ].join("\n");
}

function parseAiBuildOutput(response) {
  const outputText = stripJsonCodeFence(extractResponseText(response));
  if (!outputText) {
    throw new Error("OpenAI returned an empty build response.");
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (_error) {
    throw new Error("OpenAI returned invalid JSON for the build output.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("OpenAI returned an invalid build payload.");
  }

  return {
    pages: Array.isArray(parsed.pages) ? parsed.pages : [],
    css: Array.isArray(parsed.css) ? parsed.css : [],
    js: Array.isArray(parsed.js) ? parsed.js : [],
    assets: Array.isArray(parsed.assets) ? parsed.assets : []
  };
}

function buildFilesFromAiOutput(aiOutput, context, outputPlan, warnings) {
  const files = {};
  const builtPages = [];
  const expectedPagePaths = new Set(outputPlan.map((page) => page.path));
  const pageEntriesByPath = new Map();
  const seenPaths = new Set();

  (Array.isArray(aiOutput.pages) ? aiOutput.pages : []).forEach((entry) => {
    const normalizedPath = assertSafeBuildPath(entry && entry.path);
    if (seenPaths.has(`page:${normalizedPath}`)) {
      throw new Error(`OpenAI returned duplicate HTML for "${normalizedPath}".`);
    }
    seenPaths.add(`page:${normalizedPath}`);
    pageEntriesByPath.set(normalizedPath, entry);
  });

  const unexpectedPagePaths = Array.from(pageEntriesByPath.keys())
    .filter((pagePath) => !expectedPagePaths.has(pagePath));
  if (unexpectedPagePaths.length) {
    throw new Error(`OpenAI returned unexpected page paths: ${unexpectedPagePaths.join(", ")}.`);
  }

  outputPlan.forEach((pagePlan) => {
    const pageEntry = pageEntriesByPath.get(pagePlan.path);
    const html = String(pageEntry && pageEntry.html ? pageEntry.html : "").trim();
    if (!html) {
      throw new Error(`OpenAI did not return HTML for "${pagePlan.path}".`);
    }
    if (!/<html[\s>]/i.test(html)) {
      throw new Error(`OpenAI returned an incomplete HTML document for "${pagePlan.path}".`);
    }

    const buildPath = `build/${pagePlan.path}`;
    files[buildPath] = createTextFile(buildPath, "text/html; charset=utf-8", html);
    builtPages.push({
      id: pagePlan.pageId,
      title: pagePlan.title,
      outputPath: buildPath,
      href: pagePlan.path
    });
  });

  const cssEntries = Array.isArray(aiOutput.css) ? aiOutput.css : [];
  let hasSiteCss = false;
  cssEntries.forEach((entry) => {
    const normalizedPath = assertSafeBuildPath(entry && entry.path, "css/");
    if (seenPaths.has(`file:${normalizedPath}`)) {
      throw new Error(`OpenAI returned duplicate file content for "${normalizedPath}".`);
    }
    seenPaths.add(`file:${normalizedPath}`);

    const content = String(entry && entry.content ? entry.content : "");
    if (!content.trim()) {
      throw new Error(`OpenAI returned empty CSS for "${normalizedPath}".`);
    }

    if (normalizedPath === "css/site.css") {
      hasSiteCss = true;
    }

    const buildPath = `build/${normalizedPath}`;
    files[buildPath] = createTextFile(buildPath, "text/css; charset=utf-8", content);
  });

  if (!hasSiteCss) {
    warnings.push({
      code: "missing_generated_css",
      message: "OpenAI did not return css/site.css, so the worker applied the fallback stylesheet."
    });
    files["build/css/site.css"] = createTextFile(
      "build/css/site.css",
      "text/css; charset=utf-8",
      buildCss(buildTheme(context.brandContext))
    );
  }

  (Array.isArray(aiOutput.js) ? aiOutput.js : []).forEach((entry) => {
    const normalizedPath = assertSafeBuildPath(entry && entry.path, "js/");
    if (seenPaths.has(`file:${normalizedPath}`)) {
      throw new Error(`OpenAI returned duplicate file content for "${normalizedPath}".`);
    }
    seenPaths.add(`file:${normalizedPath}`);

    const content = String(entry && entry.content ? entry.content : "");
    if (!content.trim()) {
      throw new Error(`OpenAI returned empty JavaScript for "${normalizedPath}".`);
    }

    const buildPath = `build/${normalizedPath}`;
    files[buildPath] = createTextFile(buildPath, "application/javascript; charset=utf-8", content);
  });

  (Array.isArray(aiOutput.assets) ? aiOutput.assets : []).forEach((entry) => {
    const normalizedPath = assertSafeBuildPath(entry && entry.path, "assets/");
    if (normalizedPath.indexOf("assets/screenshots/") === 0) {
      warnings.push({
        code: "ignored_source_screenshot_asset",
        message: `Ignored AI asset output for "${normalizedPath}" because screenshots are source references from the package.`
      });
      return;
    }
    if (RESERVED_BUILD_ASSET_PATHS.has(normalizedPath)) {
      throw new Error(`OpenAI cannot overwrite the reserved asset path "${normalizedPath}".`);
    }
    if (seenPaths.has(`file:${normalizedPath}`)) {
      throw new Error(`OpenAI returned duplicate file content for "${normalizedPath}".`);
    }
    seenPaths.add(`file:${normalizedPath}`);

    const content = String(entry && entry.content ? entry.content : "");
    if (!content.trim()) {
      throw new Error(`OpenAI returned empty asset content for "${normalizedPath}".`);
    }

    const buildPath = `build/${normalizedPath}`;
    files[buildPath] = createTextFile(
      buildPath,
      String(entry && entry.contentType ? entry.contentType : "") || getContentTypeForPath(normalizedPath),
      content
    );
  });

  return {
    files,
    builtPages
  };
}

function buildVisualReferenceMap(context, builtPages) {
  return {
    generatedAt: new Date().toISOString(),
    pages: builtPages.map((page) => {
      const pageMap = context.pageMapById.get(page.id) || null;
      const asset = pageMap && pageMap.screenshotAssetPath
        ? context.assetsByLogicalPath.get(pageMap.screenshotAssetPath) || null
        : (context.assetsByPageId.get(page.id) || null);
      return {
        pageId: page.id,
        title: page.title,
        outputPath: page.outputPath,
        screenshotAssetPath: pageMap && pageMap.screenshotAssetPath ? pageMap.screenshotAssetPath : "",
        sourceUrl: asset && asset.sourceUrl ? asset.sourceUrl : "",
        sourceRef: asset && asset.sourceRef ? asset.sourceRef : null
      };
    })
  };
}

async function requestAiBuildOutput(validatedBundle, context, outputPlan, options) {
  const jobId = options && options.buildJob ? options.buildJob.id : "";
  const projectId = options && options.project ? options.project.id : context.projectId;
  const client = getOpenAIClient();
  const promptContext = buildAiPromptContext(validatedBundle, context, outputPlan);

  console.log("AI_BUILD_STARTED", jobId, projectId, outputPlan.length);
  console.log("OPENAI_REQUEST_SENT", jobId, projectId, AI_BUILD_MODEL);

  const response = await client.responses.create({
    model: AI_BUILD_MODEL,
    instructions: buildAiInstructions(validatedBundle, outputPlan),
    input: JSON.stringify(promptContext, null, 2),
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "wptoai_static_site_build",
        strict: true,
        schema: AI_BUILD_RESPONSE_SCHEMA
      }
    }
  });

  const parsed = parseAiBuildOutput(response);
  console.log(
    "OPENAI_RESPONSE_RECEIVED",
    jobId,
    projectId,
    response && response.id ? response.id : "",
    parsed.pages.length
  );

  return parsed;
}

async function createStaticSiteBuildFromPackage(validatedBundle, options) {
  if (!validatedBundle || validatedBundle.validationStatus !== "valid") {
    const error = new Error("The package bundle failed worker validation.");
    error.validation = validatedBundle;
    throw error;
  }

  const context = buildContextFromValidatedPackage(validatedBundle);
  const outputPlan = buildAiOutputPlan(context);
  const warnings = (validatedBundle.warnings || []).slice();
  const aiOutput = await requestAiBuildOutput(validatedBundle, context, outputPlan, options);
  const generated = buildFilesFromAiOutput(aiOutput, context, outputPlan, warnings);
  const files = generated.files;
  const builtPages = generated.builtPages;
  const referenceMap = buildVisualReferenceMap(context, builtPages);

  const buildLog = {
    jobId: options && options.buildJob ? options.buildJob.id : "",
    projectId: options && options.project ? options.project.id : context.projectId,
    packageId: context.manifest.package_id || "",
    startedAt: options && options.startedAt ? options.startedAt : new Date().toISOString(),
    completedAt: null,
    pageCountBuilt: builtPages.length,
    warnings,
    errors: [],
    providerUsed: options && options.provider ? options.provider : "openai",
    outputKey: "",
    outputUrl: ""
  };

  files["build/assets/visual-reference-map.json"] = createJsonFile("build/assets/visual-reference-map.json", referenceMap);
  files["build/README-build.md"] = createTextFile(
    "build/README-build.md",
    "text/markdown; charset=utf-8",
    buildReadmeBuild(context, buildLog)
  );
  files["build/build-log.json"] = createJsonFile("build/build-log.json", buildLog);

  console.log("AI_BUILD_FILES_WRITTEN", buildLog.jobId, context.projectId, builtPages.length, Object.keys(files).length);

  return {
    context,
    files,
    pageCountBuilt: builtPages.length,
    warnings,
    errors: [],
    buildLog
  };
}

module.exports = {
  WORKER_REQUIRED_PACKAGE_FILES,
  validateWorkerPackageBundle,
  createStaticSiteBuildFromPackage
};
