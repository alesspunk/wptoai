const path = require("path");

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

  const sitemapXml = files["sitemap.xml"] ? String(files["sitemap.xml"].content || "").trim() : "";
  if (!sitemapXml || sitemapXml.indexOf("<urlset") === -1) {
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
    brandContext
  };
}

function createStaticSiteBuildFromPackage(validatedBundle, options) {
  if (!validatedBundle || validatedBundle.validationStatus !== "valid") {
    const error = new Error("The package bundle failed worker validation.");
    error.validation = validatedBundle;
    throw error;
  }

  const context = buildContextFromValidatedPackage(validatedBundle);
  const theme = buildTheme(context.brandContext);
  const files = {};
  const warnings = (validatedBundle.warnings || []).slice();
  const builtPages = [];

  context.orderedPages.forEach((page) => {
    const currentFilePath = context.outputPaths.get(page.id);
    if (!currentFilePath) return;
    const isHomepage = page.id === context.homePageId;

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
    const pageType = isHomepage
      ? "homepage"
      : (context.pageTypesById.get(page.id) || page.type || "other");
    const pageSummary = inferPageSummary(
      { ...page, pageType },
      context.siteTitle,
      sectionTitles
    );

    if (!asset) {
      warnings.push({
        code: "missing_visual_reference",
        pageId: page.id,
        message: `No screenshot asset was available for "${page.title}".`
      });
    }

    const relatedPages = context.orderedPages
      .filter((candidate) => (
        candidate.id !== page.id &&
        candidate.id !== context.homePageId &&
        candidate.type !== "homepage"
      ))
      .filter((candidate) => {
        const candidateMap = context.pageMapById.get(candidate.id) || null;
        const candidateSections = Array.isArray(candidateMap && candidateMap.sectionAncestorIds)
          ? candidateMap.sectionAncestorIds
          : [];
        if (sectionTitles.length) {
          return candidateSections.some((sectionId) => sectionTitles.includes(
            (context.approvedPagesById.get(sectionId) || {}).title
          ));
        }
        return !candidate.parentId;
      })
      .slice(0, 4)
      .map((candidate) => ({
        title: candidate.title,
        summary: inferPageSummary(
          { ...candidate, pageType: context.pageTypesById.get(candidate.id) || candidate.type || "other" },
          context.siteTitle,
          []
        ),
        href: context.outputPaths.get(candidate.id)
      }));

    const documentTitle = isHomepage
      ? `${context.siteTitle}`
      : `${page.title} | ${context.siteTitle}`;
    const metaDescription = isHomepage
      ? context.siteDescription || pageSummary
      : pageSummary;

    const html = buildHtmlDocument({
      context,
      page,
      asset,
      navigation: context.navigation,
      sectionTitles,
      currentFilePath,
      isHomepage,
      siteTitle: context.siteTitle,
      documentTitle,
      metaDescription,
      pageSummary,
      relatedPages,
      footerText: `${context.orderedPages.length} approved page${context.orderedPages.length === 1 ? "" : "s"} in this build.`
    });

    const buildPath = `build/${currentFilePath}`;
    files[buildPath] = createTextFile(buildPath, "text/html; charset=utf-8", html);
    builtPages.push({
      id: page.id,
      title: page.title,
      outputPath: buildPath,
      href: currentFilePath
    });
  });

  const referenceMap = {
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

  files["build/css/site.css"] = createTextFile("build/css/site.css", "text/css; charset=utf-8", buildCss(theme));
  files["build/assets/visual-reference-map.json"] = createJsonFile("build/assets/visual-reference-map.json", referenceMap);
  files["build/README-build.md"] = createTextFile(
    "build/README-build.md",
    "text/markdown; charset=utf-8",
    buildReadmeBuild(context, buildLog)
  );
  files["build/build-log.json"] = createJsonFile("build/build-log.json", buildLog);

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
