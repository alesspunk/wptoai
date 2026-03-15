const projectRepository = require("../repositories/project.repository");
const projectPageRepository = require("../repositories/projectPage.repository");
const projectPackageRepository = require("../repositories/projectPackage.repository");
const buildJobRepository = require("../repositories/buildJob.repository");
const quoteRepository = require("../repositories/quote.repository");
const { uploadProjectPackageBundle } = require("./packageStorage.service");
const { getProjectPublishStatus } = require("./project.service");
const { sendEmail, getOrderNotificationRecipient } = require("./email.service");

const PACKAGE_VERSION = "1.0.0";
const SCHEMA_VERSION = "phase4a-package.v1";
const ROOT_SCREENSHOTS_DIR = "/assets/screenshots";
const ROOT_IMAGES_DIR = "/assets/images";
const REQUIRED_PACKAGE_FILES = [
  "manifest.json",
  "approved-pages.json",
  "sitemap.xml",
  "sitemap-readable.json",
  "page-map.json",
  "README.md",
  "golden-prompt.md",
  "implementation-rules.md"
];
const DEFAULT_BUILD_PROVIDER = process.env.AI_BUILD_PROVIDER || "openai";
const DEFAULT_BUILD_TARGET = process.env.AI_BUILD_TARGET || "static-html";

function createPublishError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = Number(statusCode || 400);
  return error;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeSiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = raw.startsWith("http://") || raw.startsWith("https://")
      ? new URL(raw)
      : new URL(`https://${raw}`);
    return parsed.toString();
  } catch (_error) {
    return raw;
  }
}

function normalizePageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch (_error) {
    return raw;
  }
}

function getHostname(value) {
  const normalized = normalizeSiteUrl(value);
  if (!normalized) return "";
  try {
    return new URL(normalized).hostname;
  } catch (_error) {
    return normalized
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .trim();
  }
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function slugify(value, fallback) {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || String(fallback || "item");
}

function isDataUrl(value) {
  return /^data:/i.test(String(value || "").trim());
}

function inferAssetExtension(sourceUrl) {
  const value = String(sourceUrl || "").trim();
  if (!value) return "png";
  if (/^data:image\/svg\+xml/i.test(value)) return "svg";
  if (/^data:image\/jpeg/i.test(value)) return "jpg";
  if (/^data:image\/webp/i.test(value)) return "webp";
  if (/^data:image\//i.test(value)) return "png";
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname || "";
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    if (match && match[1]) return match[1].toLowerCase();
  } catch (_error) {
    const match = value.match(/\.([a-z0-9]+)(?:\?|#|$)/i);
    if (match && match[1]) return match[1].toLowerCase();
  }
  return "png";
}

function stringifyJson(value) {
  return JSON.stringify(value, null, 2);
}

function createTextFile(path, contentType, content) {
  return {
    path,
    contentType,
    content: String(content || "")
  };
}

function createJsonFile(path, value) {
  return createTextFile(path, "application/json", stringifyJson(value));
}

function buildProjectSource(project, quote) {
  const sourceUrl = normalizeSiteUrl(
    (project && project.wordpressUrl) ||
    (quote && quote.siteUrl) ||
    ""
  );
  return {
    sourceUrl,
    sourceDomain: getHostname(sourceUrl)
  };
}

function getSiteTitle(project, quote, sourceDomain) {
  return normalizeWhitespace(
    (quote && quote.siteTitle) ||
    sourceDomain ||
    (project && project.wordpressUrl) ||
    "Untitled Site"
  );
}

function sortPages(pages) {
  return (Array.isArray(pages) ? pages.slice() : []).sort((a, b) => {
    const orderDelta = Number(a && a.orderIndex ? a.orderIndex : 0) - Number(b && b.orderIndex ? b.orderIndex : 0);
    if (orderDelta !== 0) return orderDelta;
    const createdA = new Date(a && a.createdAt ? a.createdAt : 0).getTime();
    const createdB = new Date(b && b.createdAt ? b.createdAt : 0).getTime();
    if (createdA !== createdB) return createdA - createdB;
    return String(a && a.id ? a.id : "").localeCompare(String(b && b.id ? b.id : ""));
  });
}

function isRoutablePage(page) {
  return page && (page.type === "homepage" || page.type === "page");
}

function buildPageLookup(pages) {
  const lookup = new Map();
  pages.forEach((page) => {
    lookup.set(page.id, page);
  });
  return lookup;
}

function buildChildrenLookup(pages) {
  const lookup = new Map();
  pages.forEach((page) => {
    const parentId = page.parentId || null;
    if (!lookup.has(parentId)) {
      lookup.set(parentId, []);
    }
    lookup.get(parentId).push(page);
  });
  lookup.forEach((siblings) => {
    siblings.sort((a, b) => {
      if (a.orderIndex === b.orderIndex) {
        return String(a.title || "").localeCompare(String(b.title || ""));
      }
      return Number(a.orderIndex || 0) - Number(b.orderIndex || 0);
    });
  });
  return lookup;
}

function validateHierarchy(pages) {
  const pageLookup = buildPageLookup(pages);
  const visiting = new Set();
  const visited = new Set();

  pages.forEach((page) => {
    if (!page.parentId) return;
    const parent = pageLookup.get(page.parentId);
    if (!parent) {
      throw createPublishError(`Page "${page.title}" references a missing parent.`, 400);
    }
    if (parent.type !== "section") {
      throw createPublishError(`Page "${page.title}" must be nested under a section.`, 400);
    }
  });

  function walk(page) {
    if (!page || visited.has(page.id)) return;
    if (visiting.has(page.id)) {
      throw createPublishError("The page hierarchy contains a cycle and cannot be published.", 400);
    }
    visiting.add(page.id);
    if (page.parentId) {
      walk(pageLookup.get(page.parentId));
    }
    visiting.delete(page.id);
    visited.add(page.id);
  }

  pages.forEach(walk);

  const homepage = pages.find((page) => page.type === "homepage") || null;
  const rootRoutable = pages.find((page) => isRoutablePage(page) && !page.parentId) || null;
  if (!homepage && !rootRoutable) {
    throw createPublishError("Add a homepage or a root page before converting to AI.", 400);
  }

  return {
    homepageId: homepage ? homepage.id : (rootRoutable ? rootRoutable.id : ""),
    pageLookup,
    childrenLookup: buildChildrenLookup(pages)
  };
}

function classifyPageType(page) {
  if (!page) return "other";
  if (page.type === "homepage") return "homepage";
  const haystack = `${page.title || ""} ${page.url || ""}`.toLowerCase();
  if (/\b(contact|book|appointment|get in touch|reach us)\b/.test(haystack)) return "contact";
  if (/\b(service|services|solutions|offerings|capabilities)\b/.test(haystack)) return "services";
  if (/\b(blog|news|articles|resources|portfolio|projects|cases|case-studies|work)\b/.test(haystack)) return "listing";
  if (/\b(about|team|faq|pricing|plans|story|mission|company)\b/.test(haystack)) return "content";
  return "other";
}

function inferPagePriority(page) {
  if (!page) return "normal";
  if (page.type === "homepage") return "high";
  if (page.parentId) return "low";
  return "normal";
}

function buildScreenshotAsset(page, quote) {
  const directScreenshotUrl = String(page && page.screenshotUrl ? page.screenshotUrl : "").trim();
  const homepagePreviewUrl = page && page.type === "homepage"
    ? String(quote && quote.previewImageUrl ? quote.previewImageUrl : "").trim()
    : "";

  let sourceType = "";
  let sourceUrl = "";
  let sourceRef = null;

  if (directScreenshotUrl) {
    sourceType = "project_page";
    if (!isDataUrl(directScreenshotUrl)) {
      sourceUrl = directScreenshotUrl;
    } else {
      sourceRef = {
        type: "project_page",
        projectPageId: page.id,
        field: "screenshot_url",
        inlineSourceOmitted: true
      };
    }
  } else if (homepagePreviewUrl) {
    sourceType = "quote_preview";
    if (!isDataUrl(homepagePreviewUrl)) {
      sourceUrl = homepagePreviewUrl;
    } else {
      sourceRef = {
        type: "quote",
        quoteId: quote && quote.id ? quote.id : null,
        field: "preview_image_url",
        inlineSourceOmitted: true
      };
    }
  }

  if (!sourceType) return null;

  const extension = inferAssetExtension(sourceUrl || homepagePreviewUrl || directScreenshotUrl);
  const logicalPath = `${ROOT_SCREENSHOTS_DIR}/${String(page.orderIndex || 0).padStart(2, "0")}-${slugify(page.title || page.id, page.id)}.${extension}`;

  return {
    assetId: `asset_${page.id}`,
    logicalPath,
    kind: "screenshot",
    pageId: page.id,
    pageTitle: page.title,
    sourceType,
    sourceUrl,
    sourceRef,
    sourceScreenshotUrl: directScreenshotUrl || "",
    previewFallbackUsed: !directScreenshotUrl && sourceType === "quote_preview"
  };
}

function collectAncestorIds(page, pageLookup) {
  const ids = [];
  let cursor = page;
  const seen = new Set();
  while (cursor && cursor.parentId) {
    if (seen.has(cursor.parentId)) break;
    seen.add(cursor.parentId);
    ids.unshift(cursor.parentId);
    cursor = pageLookup.get(cursor.parentId) || null;
  }
  return ids;
}

function collectDescendantRoutablePages(sectionId, childrenLookup) {
  const descendants = [];
  const queue = [sectionId];

  while (queue.length) {
    const nextId = queue.shift();
    const children = childrenLookup.get(nextId) || [];
    children.forEach((child) => {
      if (child.type === "section") {
        queue.push(child.id);
      } else if (isRoutablePage(child)) {
        descendants.push(child);
      }
    });
  }

  return descendants;
}

function buildReadableTree(parentId, childrenLookup, pageLookup, assetsByPageId) {
  const siblings = childrenLookup.get(parentId || null) || [];
  return siblings.map((page) => {
    const asset = assetsByPageId.get(page.id) || null;
    const pagePriority = inferPagePriority(page);
    return {
      id: page.id,
      title: page.title,
      url: normalizePageUrl(page.url || ""),
      type: page.type,
      status: page.status,
      orderIndex: Number(page.orderIndex || 0),
      pagePriority,
      screenshotUrl: asset ? asset.logicalPath : "",
      children: buildReadableTree(page.id, childrenLookup, pageLookup, assetsByPageId)
    };
  });
}

function buildSitemapXml(routablePages, generatedAt) {
  const entries = routablePages
    .filter((page) => String(page.url || "").trim())
    .map((page) => {
      const lastmod = generatedAt.slice(0, 10);
      const priority = page.pagePriority === "high"
        ? "1.0"
        : (page.pagePriority === "low" ? "0.5" : "0.7");
      return [
        "  <url>",
        `    <loc>${escapeXml(page.url)}</loc>`,
        `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
        `    <priority>${priority}</priority>`,
        "  </url>"
      ].join("\n");
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries.join("\n"),
    "</urlset>"
  ].join("\n");
}

function buildReadme(snapshot) {
  return [
    "# WPtoAI Publish Package",
    "",
    `Project: \`${snapshot.project.id}\``,
    `Package: \`${snapshot.manifest.package_id}\``,
    `Generated: \`${snapshot.generatedAt}\``,
    "",
    "This package captures the approved Project Area snapshot that should be used by the future AI build worker.",
    "",
    "## Source of truth",
    "- Pages: `approved-pages.json`",
    "- Hierarchy: `sitemap.xml` and `sitemap-readable.json`",
    "- Page screenshot mapping: `page-map.json`",
    "- Branding context: `brand-context.json`",
    "- Assets: `assets-manifest.json`",
    "- Visual references directory: `/assets/screenshots`",
    "",
    "## Notes",
    "- Asset files in this package are logical references only. Use `assets-manifest.json` to resolve the original source URL or source field.",
    "- Do not invent extra pages or section groups beyond the approved Project Area structure.",
    "- `approved-pages.json` includes section nodes used to preserve grouping, while `sitemap.xml` includes routable pages only.",
    "",
    "## Intended worker flow",
    "1. Read `manifest.json`, `project-summary.json`, and `README.md`.",
    "2. Build the site structure from `approved-pages.json` plus `sitemap-readable.json`.",
    "3. Resolve screenshots and visual references through `assets-manifest.json` and `page-map.json`.",
    "4. Apply branding rules from `brand-context.json`.",
    "5. Follow `golden-prompt.md` and `implementation-rules.md` during generation."
  ].join("\n");
}

function buildGoldenPrompt(snapshot) {
  return [
    "# Golden Prompt",
    "",
    "Build a production-ready migration of this approved WordPress project into a static website using HTML, CSS, and vanilla JavaScript only.",
    "",
    "## Non-negotiable rules",
    "- Preserve the brand, layout intent, hierarchy, and navigation from the approved snapshot.",
    "- Use `approved-pages.json` as the page/source-of-truth document for approved nodes and page metadata.",
    "- Use `sitemap.xml` and `sitemap-readable.json` to preserve routable structure and navigation hierarchy.",
    "- Use `page-map.json` and `/assets/screenshots` references to match approved visual structure and screenshot inheritance.",
    "- Reuse available screenshots and assets as references before inventing anything new.",
    "- Prefer semantic HTML and clean maintainable CSS/JS.",
    "- Do not use emojis. Use SVG icons when icons are needed.",
    "- Do not invent unrelated visual style, extra pages, extra sections, or WordPress-specific runtime behavior.",
    "- Avoid unnecessary libraries and keep the output deployable on Vercel as static files.",
    "",
    "## Package source-of-truth",
    "- Pages: `approved-pages.json`",
    "- Hierarchy: `sitemap.xml`",
    "- Screenshot mapping: `page-map.json`",
    "- Branding: `brand-context.json`",
    "- Assets: `assets-manifest.json`",
    "",
    "## Build target",
    "- Output: static HTML, CSS, and vanilla JavaScript",
    "- Deploy target: Vercel",
    "- WordPress runtime dependency: none"
  ].join("\n");
}

function buildImplementationRules() {
  return [
    "# Implementation Rules",
    "",
    "- Follow `sitemap.xml` for routable pages.",
    "- Follow `page-map.json` for screenshot usage and page-to-reference mapping.",
    "- Preserve branding from `brand-context.json` and screenshots.",
    "- Prefer assets already listed in `assets-manifest.json`.",
    "- Respect the approved hierarchy from `approved-pages.json`.",
    "- Use semantic HTML.",
    "- Keep CSS and JavaScript framework-free unless a package file explicitly says otherwise.",
    "- Do not add a WordPress runtime dependency.",
    "- Do not invent new pages, sections, or navigation items.",
    "- Keep the output maintainable and easy to extend."
  ].join("\n");
}

function buildSnapshot({ project, quote, pages }) {
  const generatedAt = new Date().toISOString();
  const { sourceUrl, sourceDomain } = buildProjectSource(project, quote);
  const siteTitle = getSiteTitle(project, quote, sourceDomain);
  const siteDescription = normalizeWhitespace(quote && quote.siteDescription);
  const sortedPages = sortPages(pages).map((page) => ({
    id: page.id,
    title: normalizeWhitespace(page.title || "Untitled"),
    url: normalizePageUrl(page.url || ""),
    type: page.type,
    parentId: page.parentId || null,
    status: String(page.status || "queued"),
    screenshotUrl: String(page.screenshotUrl || ""),
    orderIndex: Number(page.orderIndex || 0),
    createdAt: page.createdAt || null,
    updatedAt: page.updatedAt || null
  }));

  if (!sortedPages.length) {
    throw createPublishError("Add at least one approved page before converting to AI.", 400);
  }

  const routablePages = sortedPages.filter(isRoutablePage);
  if (!routablePages.length) {
    throw createPublishError("Add at least one approved page before converting to AI.", 400);
  }

  const hierarchy = validateHierarchy(sortedPages);
  const assets = [];
  const assetsByPageId = new Map();
  const warnings = [];

  sortedPages.forEach((page) => {
    const asset = buildScreenshotAsset(page, quote);
    if (asset) {
      assets.push(asset);
      assetsByPageId.set(page.id, asset);
      return;
    }
    if (isRoutablePage(page)) {
      warnings.push({
        code: "missing_visual_reference",
        pageId: page.id,
        message: `Page "${page.title}" does not have a saved screenshot reference.`
      });
    }
  });

  const approvedPages = sortedPages.map((page) => {
    const asset = assetsByPageId.get(page.id) || null;
    return {
      id: page.id,
      title: page.title,
      url: page.url,
      type: page.type,
      parentId: page.parentId,
      orderIndex: page.orderIndex,
      status: page.status,
      pagePriority: inferPagePriority(page),
      screenshotUrl: asset ? asset.logicalPath : "",
      sourceScreenshotUrl: asset ? asset.sourceScreenshotUrl : "",
      screenshotSource: asset ? asset.sourceType : ""
    };
  });

  const pageTypes = routablePages.map((page) => ({
    pageId: page.id,
    title: page.title,
    url: page.url,
    pageType: classifyPageType(page)
  }));

  const pageMap = approvedPages.map((page) => {
    const source = hierarchy.pageLookup.get(page.id);
    const ancestors = collectAncestorIds(source, hierarchy.pageLookup);
    return {
      pageId: page.id,
      title: page.title,
      type: page.type,
      parentId: page.parentId,
      hierarchyPath: ancestors.concat(page.id),
      sectionAncestorIds: ancestors.filter((ancestorId) => {
        const ancestor = hierarchy.pageLookup.get(ancestorId);
        return ancestor && ancestor.type === "section";
      }),
      screenshotAssetPath: page.screenshotUrl || "",
      screenshotSource: page.screenshotSource || "",
      sourceScreenshotUrl: page.sourceScreenshotUrl || ""
    };
  });

  const sectionInheritance = approvedPages
    .filter((page) => page.type === "section")
    .map((section) => {
      const descendants = collectDescendantRoutablePages(section.id, hierarchy.childrenLookup);
      return {
        sectionId: section.id,
        sectionTitle: section.title,
        descendantPageIds: descendants.map((item) => item.id),
        visualReferenceAssetPaths: descendants
          .map((item) => {
            const asset = assetsByPageId.get(item.id);
            return asset ? asset.logicalPath : "";
          })
          .filter(Boolean)
      };
    });

  const readableTree = buildReadableTree(null, hierarchy.childrenLookup, hierarchy.pageLookup, assetsByPageId);
  const approvedPageCount = routablePages.length;
  const screenshotCount = assets.length;
  const sectionCount = approvedPages.filter((page) => page.type === "section").length;

  const manifest = {
    package_id: `pkg_${project.id}`,
    project_id: project.id,
    client_id: project.userId || null,
    client_email: project.customerEmail || (quote && quote.email ? quote.email : null),
    quote_id: project.quoteId || (quote && quote.id ? quote.id : null),
    package_version: PACKAGE_VERSION,
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    source_domain: sourceDomain,
    approved_page_count: approvedPageCount,
    screenshot_count: screenshotCount,
    asset_count: assets.length
  };

  const buildConfig = {
    packageVersion: PACKAGE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    targetOutput: "static-html-css-js",
    deployTarget: "vercel",
    repoVisibilityDefault: "private",
    imageStrategy: {
      mode: "reference-first",
      screenshotsDirectory: ROOT_SCREENSHOTS_DIR,
      imagesDirectory: ROOT_IMAGES_DIR,
      embedBinaryAssetsInPackage: false
    },
    cssStrategy: "shared-vanilla-css-with-page-specific-sections",
    componentStrategy: "semantic-sections-and-reusable-html-partials",
    javascriptStrategy: "vanilla-js",
    buildIntent: "ai_migration_build",
    wordpressRuntimeDependency: false
  };

  const assetsManifest = {
    generatedAt,
    directories: {
      images: ROOT_IMAGES_DIR,
      screenshots: ROOT_SCREENSHOTS_DIR
    },
    assets: assets.map((asset) => ({
      assetId: asset.assetId,
      logicalPath: asset.logicalPath,
      kind: asset.kind,
      pageId: asset.pageId,
      pageTitle: asset.pageTitle,
      sourceType: asset.sourceType,
      sourceUrl: asset.sourceUrl || null,
      sourceRef: asset.sourceRef || null,
      previewFallbackUsed: asset.previewFallbackUsed
    }))
  };

  const projectSummary = {
    projectId: project.id,
    sourceDomain,
    siteTitle,
    siteDescription,
    approvedPageCount,
    sectionCount,
    screenshotsReadyCount: screenshotCount,
    publishTimestamp: generatedAt
  };

  const sitemapReadable = {
    generatedAt,
    rootPageId: hierarchy.homepageId,
    tree: readableTree
  };

  const brandContext = {
    siteTitle,
    siteDescription,
    domain: sourceDomain,
    mainColors: [],
    logoUrls: [],
    typographyHints: [],
    referenceAssets: assets.slice(0, 4).map((asset) => asset.logicalPath),
    visualIdentityNotes: [
      "Preserve the current brand and composition shown in the approved screenshots.",
      "No extracted brand palette or logo file was persisted in this phase unless listed in assets-manifest.json.",
      "Treat screenshots as the primary fidelity reference when explicit brand tokens are missing."
    ]
  };

  const buildLog = {
    packageId: manifest.package_id,
    generatedAt,
    status: "package_assembled",
    validations: [
      { code: "project_exists", passed: true },
      { code: "project_is_paid", passed: true },
      { code: "approved_pages_present", passed: approvedPageCount > 0 },
      { code: "homepage_or_root_present", passed: Boolean(hierarchy.homepageId) },
      { code: "hierarchy_readable", passed: true },
      { code: "package_files_assembled", passed: true }
    ],
    warnings
  };

  const files = {
    "manifest.json": createJsonFile("manifest.json", manifest),
    "build-config.json": createJsonFile("build-config.json", buildConfig),
    "assets-manifest.json": createJsonFile("assets-manifest.json", assetsManifest),
    "page-types.json": createJsonFile("page-types.json", {
      generatedAt,
      pages: pageTypes
    }),
    "project-summary.json": createJsonFile("project-summary.json", projectSummary),
    "approved-pages.json": createJsonFile("approved-pages.json", {
      generatedAt,
      pages: approvedPages
    }),
    "page-map.json": createJsonFile("page-map.json", {
      generatedAt,
      pageMappings: pageMap,
      sectionInheritance
    }),
    "sitemap.xml": createTextFile("sitemap.xml", "application/xml", buildSitemapXml(approvedPages.filter(isRoutablePage), generatedAt)),
    "sitemap-readable.json": createJsonFile("sitemap-readable.json", sitemapReadable),
    "brand-context.json": createJsonFile("brand-context.json", brandContext),
    "README.md": createTextFile("README.md", "text/markdown", buildReadme({
      generatedAt,
      project,
      manifest
    })),
    "golden-prompt.md": createTextFile("golden-prompt.md", "text/markdown", buildGoldenPrompt({
      generatedAt,
      manifest
    })),
    "implementation-rules.md": createTextFile("implementation-rules.md", "text/markdown", buildImplementationRules()),
    "build-log.json": createJsonFile("build-log.json", buildLog)
  };

  return {
    generatedAt,
    manifest,
    files,
    snapshot: {
      generatedAt,
      sourceUrl,
      sourceDomain,
      siteTitle,
      siteDescription,
      approvedPages,
      pageTypes,
      pageMap,
      sectionInheritance,
      readableTree,
      assets: assetsManifest.assets,
      warnings
    },
    summary: {
      packageId: manifest.package_id,
      packageVersion: PACKAGE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      approvedPageCount,
      screenshotCount,
      assetCount: assets.length,
      filesCount: Object.keys(files).length,
      assembledAt: generatedAt
    }
  };
}

function getPackageGeneratedAt(packageRecord) {
  return packageRecord && packageRecord.packageGeneratedAt
    ? packageRecord.packageGeneratedAt
    : String(
      packageRecord &&
      packageRecord.manifest &&
      packageRecord.manifest.generated_at
        ? packageRecord.manifest.generated_at
        : ""
    ).trim() || null;
}

function getApprovedPageCountFromPackage(packageRecord) {
  if (packageRecord && Number.isFinite(Number(packageRecord.approvedPageCount))) {
    const explicit = Number(packageRecord.approvedPageCount);
    if (explicit > 0) return explicit;
  }
  return Number(
    packageRecord &&
    packageRecord.manifest &&
    packageRecord.manifest.approved_page_count
      ? packageRecord.manifest.approved_page_count
      : 0
  );
}

function buildPackageSummary(packageRecord, project, buildJob) {
  return {
    packageId: packageRecord && packageRecord.id ? packageRecord.id : null,
    packageVersion: packageRecord && packageRecord.packageVersion ? packageRecord.packageVersion : PACKAGE_VERSION,
    schemaVersion: packageRecord && packageRecord.schemaVersion ? packageRecord.schemaVersion : SCHEMA_VERSION,
    approvedPageCount: getApprovedPageCountFromPackage(packageRecord),
    screenshotCount: Number(
      packageRecord &&
      packageRecord.manifest &&
      packageRecord.manifest.screenshot_count
        ? packageRecord.manifest.screenshot_count
        : 0
    ),
    assetCount: Number(
      packageRecord &&
      packageRecord.manifest &&
      packageRecord.manifest.asset_count
        ? packageRecord.manifest.asset_count
        : 0
    ),
    filesCount: Object.keys((packageRecord && packageRecord.files) || {}).length,
    assembledAt: getPackageGeneratedAt(packageRecord) || (project && project.packageAssembledAt) || null,
    validationStatus: packageRecord && packageRecord.validationStatus ? packageRecord.validationStatus : "pending",
    packageKey: packageRecord && packageRecord.packageKey ? packageRecord.packageKey : null,
    packageUrl: packageRecord && packageRecord.packageUrl ? packageRecord.packageUrl : null,
    buildJobId: buildJob && buildJob.id
      ? buildJob.id
      : (
        packageRecord && packageRecord.buildJobId
          ? packageRecord.buildJobId
          : (project && project.buildJobId ? project.buildJobId : null)
      ),
    submittedAt: packageRecord && packageRecord.submittedAt
      ? packageRecord.submittedAt
      : (project && project.submittedAt ? project.submittedAt : null)
  };
}

function parsePackageJsonFile(packageRecord, fileName, errors) {
  const file = packageRecord && packageRecord.files ? packageRecord.files[fileName] : null;
  if (!file || !String(file.content || "").trim()) {
    errors.push({
      code: "missing_file",
      file: fileName,
      message: `${fileName} is missing from the assembled package.`
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

function validateScreenshotReferences(assetsManifest, approvedPages, pageMap, errors) {
  const assets = Array.isArray(assetsManifest && assetsManifest.assets) ? assetsManifest.assets : [];
  const assetPathSet = new Set();

  assets.forEach((asset, index) => {
    const logicalPath = String(asset && asset.logicalPath ? asset.logicalPath : "").trim();
    if (!logicalPath || logicalPath.indexOf(ROOT_SCREENSHOTS_DIR + "/") !== 0) {
      errors.push({
        code: "invalid_screenshot_path",
        file: "assets-manifest.json",
        message: `Screenshot asset at index ${index} is missing a valid logicalPath.`
      });
    } else {
      assetPathSet.add(logicalPath);
    }

    const hasSourceUrl = Boolean(String(asset && asset.sourceUrl ? asset.sourceUrl : "").trim());
    const sourceRef = asset && asset.sourceRef ? asset.sourceRef : null;
    if (!hasSourceUrl && !sourceRef) {
      errors.push({
        code: "missing_screenshot_source",
        file: "assets-manifest.json",
        message: `Screenshot asset "${logicalPath || index}" is missing both sourceUrl and sourceRef.`
      });
    }
  });

  approvedPages.forEach((page) => {
    const screenshotUrl = String(page && page.screenshotUrl ? page.screenshotUrl : "").trim();
    if (screenshotUrl && !assetPathSet.has(screenshotUrl)) {
      errors.push({
        code: "unmapped_page_screenshot",
        file: "approved-pages.json",
        message: `Approved page "${page && page.title ? page.title : page && page.id ? page.id : "page"}" references a screenshot not found in assets-manifest.json.`
      });
    }
  });

  pageMap.forEach((mapping) => {
    const screenshotAssetPath = String(mapping && mapping.screenshotAssetPath ? mapping.screenshotAssetPath : "").trim();
    if (screenshotAssetPath && !assetPathSet.has(screenshotAssetPath)) {
      errors.push({
        code: "invalid_page_map_screenshot",
        file: "page-map.json",
        message: `Page map entry "${mapping && mapping.pageId ? mapping.pageId : "unknown"}" references a screenshot not found in assets-manifest.json.`
      });
    }
  });

  return assets.length;
}

function validateProjectPackage(packageRecord) {
  const errors = [];
  const warnings = [];
  const files = packageRecord && packageRecord.files && typeof packageRecord.files === "object"
    ? packageRecord.files
    : {};

  REQUIRED_PACKAGE_FILES.forEach((fileName) => {
    const file = files[fileName];
    if (!file || !String(file.content || "").trim()) {
      errors.push({
        code: "missing_file",
        file: fileName,
        message: `${fileName} is required for build handoff.`
      });
    }
  });

  const manifest = parsePackageJsonFile(packageRecord, "manifest.json", errors);
  const approvedPagesPayload = parsePackageJsonFile(packageRecord, "approved-pages.json", errors);
  const sitemapReadable = parsePackageJsonFile(packageRecord, "sitemap-readable.json", errors);
  const pageMapPayload = parsePackageJsonFile(packageRecord, "page-map.json", errors);
  const assetsManifest = files["assets-manifest.json"]
    ? parsePackageJsonFile(packageRecord, "assets-manifest.json", errors)
    : { assets: [] };
  const brandContext = files["brand-context.json"]
    ? parsePackageJsonFile(packageRecord, "brand-context.json", errors)
    : null;

  const sitemapXml = files["sitemap.xml"] ? String(files["sitemap.xml"].content || "").trim() : "";
  if (!sitemapXml) {
    errors.push({
      code: "missing_file",
      file: "sitemap.xml",
      message: "sitemap.xml is required for build handoff."
    });
  } else if (sitemapXml.indexOf("<urlset") === -1) {
    errors.push({
      code: "invalid_sitemap_xml",
      file: "sitemap.xml",
      message: "sitemap.xml does not contain a valid urlset root."
    });
  }

  const readme = files["README.md"] ? String(files["README.md"].content || "").trim() : "";
  if (!readme) {
    errors.push({
      code: "missing_file",
      file: "README.md",
      message: "README.md is required for build handoff."
    });
  }

  const goldenPrompt = files["golden-prompt.md"] ? String(files["golden-prompt.md"].content || "").trim() : "";
  if (!goldenPrompt) {
    errors.push({
      code: "missing_file",
      file: "golden-prompt.md",
      message: "golden-prompt.md is required for build handoff."
    });
  }

  const implementationRules = files["implementation-rules.md"] ? String(files["implementation-rules.md"].content || "").trim() : "";
  if (!implementationRules) {
    errors.push({
      code: "missing_file",
      file: "implementation-rules.md",
      message: "implementation-rules.md is required for build handoff."
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

  const approvedPages = approvedPagesPayload && Array.isArray(approvedPagesPayload.pages)
    ? approvedPagesPayload.pages
    : [];
  if (!approvedPages.length) {
    errors.push({
      code: "empty_approved_pages",
      file: "approved-pages.json",
      message: "approved-pages.json must contain at least one approved page."
    });
  }

  const readableTree = sitemapReadable && Array.isArray(sitemapReadable.tree) ? sitemapReadable.tree : [];
  if (!readableTree.length) {
    errors.push({
      code: "empty_hierarchy",
      file: "sitemap-readable.json",
      message: "sitemap-readable.json must contain a readable hierarchy."
    });
  }

  const pageMappings = pageMapPayload && Array.isArray(pageMapPayload.pageMappings)
    ? pageMapPayload.pageMappings
    : [];

  const routablePages = approvedPages.filter((page) => page && (page.type === "homepage" || page.type === "page"));
  const rootRoutablePage = routablePages.find((page) => !page.parentId) || null;
  if (!routablePages.length) {
    errors.push({
      code: "missing_routable_pages",
      file: "approved-pages.json",
      message: "The package must include at least one homepage or page."
    });
  }
  if (!routablePages.find((page) => page.type === "homepage") && !rootRoutablePage) {
    warnings.push({
      code: "missing_homepage_root",
      file: "approved-pages.json",
      message: "No homepage was found. A root page exists, but verify the final navigation intent."
    });
  }

  const screenshotCount = validateScreenshotReferences(
    assetsManifest || {},
    approvedPages,
    pageMappings,
    errors
  );

  if (manifest && Number.isFinite(Number(manifest.screenshot_count))) {
    const manifestScreenshotCount = Number(manifest.screenshot_count);
    if (manifestScreenshotCount !== screenshotCount) {
      warnings.push({
        code: "screenshot_count_mismatch",
        file: "manifest.json",
        message: `manifest.json screenshot_count (${manifestScreenshotCount}) does not match assets-manifest.json (${screenshotCount}).`
      });
    }
  }

  if (!brandContext) {
    warnings.push({
      code: "missing_brand_context",
      file: "brand-context.json",
      message: "brand-context.json is recommended even when partial."
    });
  }

  return {
    validationStatus: errors.length ? "failed_validation" : "valid",
    errors,
    warnings,
    manifest,
    approvedPages,
    screenshotCount
  };
}

async function sendInternalBuildReadyNotification(project, packageRecord, buildJob) {
  const recipient = getOrderNotificationRecipient();
  if (!recipient) {
    console.error("BUILD_JOB_NOTIFICATION_SKIPPED", "ORDER_NOTIFICATION_TO is not configured.");
    return false;
  }

  const manifest = packageRecord && packageRecord.manifest ? packageRecord.manifest : {};
  const sourceDomain = String(
    packageRecord && packageRecord.sourceDomain
      ? packageRecord.sourceDomain
      : (manifest && manifest.source_domain ? manifest.source_domain : "")
  ).trim();
  const approvedPageCount = getApprovedPageCountFromPackage(packageRecord);

  const subject = `WPtoAI build job queued for ${sourceDomain || project.id}`;
  const html = [
    "<p>A new WPtoAI build job is ready for future AI worker processing.</p>",
    `<p><strong>Client ID:</strong> ${project && project.userId ? project.userId : "n/a"}</p>`,
    `<p><strong>Project ID:</strong> ${project && project.id ? project.id : "n/a"}</p>`,
    `<p><strong>Quote ID:</strong> ${project && project.quoteId ? project.quoteId : "n/a"}</p>`,
    `<p><strong>Domain:</strong> ${sourceDomain || "n/a"}</p>`,
    `<p><strong>Approved page count:</strong> ${approvedPageCount}</p>`,
    `<p><strong>Package key:</strong> ${packageRecord && packageRecord.packageKey ? packageRecord.packageKey : "n/a"}</p>`,
    `<p><strong>Package URL:</strong> ${packageRecord && packageRecord.packageUrl ? packageRecord.packageUrl : "n/a"}</p>`,
    `<p><strong>Build job ID:</strong> ${buildJob && buildJob.id ? buildJob.id : "n/a"}</p>`
  ].join("");

  try {
    await sendEmail(recipient, subject, html);
    console.log("BUILD_JOB_NOTIFICATION_SENT", recipient, project && project.id ? project.id : "n/a", buildJob && buildJob.id ? buildJob.id : "n/a");
    return true;
  } catch (error) {
    console.error(
      "BUILD_JOB_NOTIFICATION_ERROR",
      project && project.id ? project.id : "n/a",
      error && error.message ? error.message : error
    );
    return false;
  }
}

async function validateProjectForPublish(project, quote, pages) {
  if (!project || !project.id) {
    throw createPublishError("Project not found.", 404);
  }

  if (project && project.queueStatus === "processing") {
    throw createPublishError("Please wait for the current page preparation to finish, then try again.", 409);
  }

  if (project && project.quoteId) {
    if (!quote || !quote.id) {
      throw createPublishError("This project is missing its quote record and cannot be published yet.", 400);
    }
    if (quote.status !== "paid") {
      throw createPublishError("This project must be paid before it can be converted to AI.", 400);
    }
  }

  if (!Array.isArray(pages) || !pages.length) {
    throw createPublishError("Add at least one approved page before converting to AI.", 400);
  }
}

async function ensureProjectPackageAssembled(project) {
  if (!project || !project.id) {
    throw createPublishError("Project not found.", 404);
  }

  const existingPackage = await projectPackageRepository.findProjectPackageByProjectId(project.id);
  const currentPublishStatus = getProjectPublishStatus(project);
  if (
    existingPackage &&
    Object.keys(existingPackage.files || {}).length &&
    (
      currentPublishStatus === "package_assembled" ||
      currentPublishStatus === "submitted" ||
      currentPublishStatus === "failed_validation" ||
      currentPublishStatus === "publish_failed" ||
      currentPublishStatus === "build_failed" ||
      currentPublishStatus === "build_ready_for_publish"
    )
  ) {
    return {
      project,
      packageRecord: existingPackage,
      packageSummary: buildPackageSummary(existingPackage, project, null),
      reusedExistingPackage: true
    };
  }

  const quote = project.quoteId
    ? await quoteRepository.findQuoteById(project.quoteId)
    : null;
  const pages = await projectPageRepository.findProjectPagesByProjectId(project.id);
  await validateProjectForPublish(project, quote, pages);

  const assembled = buildSnapshot({ project, quote, pages });

  console.log("PROJECT_PUBLISH_START", project.id, currentPublishStatus, assembled.summary.packageId);
  const publishingProject = await projectRepository.markProjectPublishing(
    project.id,
    PACKAGE_VERSION,
    SCHEMA_VERSION
  );

  try {
    const packageRecord = await projectPackageRepository.upsertProjectPackage({
      projectId: project.id,
      quoteId: project.quoteId || (quote && quote.id ? quote.id : null),
      packageVersion: PACKAGE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      status: "package_assembled",
      validationStatus: "pending",
      validationErrors: [],
      storageManifest: {},
      packageKey: null,
      packageUrl: null,
      packageGeneratedAt: assembled.generatedAt,
      sourceDomain: assembled.manifest.source_domain || null,
      approvedPageCount: Number(assembled.manifest.approved_page_count || 0),
      buildJobId: null,
      submittedAt: null,
      manifest: assembled.manifest,
      files: assembled.files,
      snapshot: assembled.snapshot
    });
    const finishedProject = await projectRepository.markProjectPackageAssembled(
      publishingProject.id,
      PACKAGE_VERSION,
      SCHEMA_VERSION,
      assembled.summary.assembledAt
    );
    console.log("PROJECT_PUBLISH_OK", project.id, assembled.summary.packageId);
    return {
      project: finishedProject,
      packageRecord,
      packageSummary: buildPackageSummary(packageRecord, finishedProject, null),
      reusedExistingPackage: false
    };
  } catch (error) {
    await projectRepository.markProjectPublishFailed(
      publishingProject.id,
      PACKAGE_VERSION,
      SCHEMA_VERSION
    );
    console.error("PROJECT_PUBLISH_ERROR", project.id, error && error.message ? error.message : error);
    throw error;
  }
}

async function ensureBuildJob(project, packageRecord) {
  const existingBuildJob = await buildJobRepository.findBuildJobByProjectId(project.id);
  const existingStatus = String(existingBuildJob && existingBuildJob.status ? existingBuildJob.status : "").toLowerCase();
  if (
    existingBuildJob &&
    existingBuildJob.packageKey === packageRecord.packageKey &&
    existingStatus &&
    existingStatus !== "failed" &&
    existingStatus !== "build_failed" &&
    existingStatus !== "canceled"
  ) {
    return {
      buildJob: existingBuildJob,
      reusedExistingJob: true
    };
  }

  const buildJob = await buildJobRepository.upsertBuildJob({
    id: existingBuildJob && existingBuildJob.id ? existingBuildJob.id : null,
    projectId: project.id,
    quoteId: project.quoteId || null,
    packageKey: packageRecord.packageKey,
    packageUrl: packageRecord.packageUrl || null,
    status: "queued",
    provider: DEFAULT_BUILD_PROVIDER,
    target: DEFAULT_BUILD_TARGET,
    retryCount: existingBuildJob && Number.isFinite(Number(existingBuildJob.retryCount))
      ? Number(existingBuildJob.retryCount)
      : 0
  });

  return {
    buildJob,
    reusedExistingJob: false
  };
}

async function submitProjectForBuild(project) {
  if (!project || !project.id) {
    throw createPublishError("Project not found.", 404);
  }

  const existingPackage = await projectPackageRepository.findProjectPackageByProjectId(project.id);
  const existingBuildJob = await buildJobRepository.findBuildJobByProjectId(project.id);
  const currentPublishStatus = getProjectPublishStatus(project);

  if (
    currentPublishStatus === "submitted" &&
    existingPackage &&
    existingPackage.validationStatus === "valid" &&
    existingPackage.packageKey &&
    existingPackage.packageUrl &&
    existingBuildJob &&
    existingBuildJob.packageKey === existingPackage.packageKey
  ) {
    return {
      project,
      packageRecord: existingPackage,
      buildJob: existingBuildJob,
      packageSummary: buildPackageSummary(existingPackage, project, existingBuildJob),
      reusedExistingPackage: true,
      reusedExistingJob: true,
      notificationSent: false
    };
  }

  let workingProject = project;
  let packageResult = await ensureProjectPackageAssembled(workingProject);
  workingProject = packageResult.project;
  let packageRecord = packageResult.packageRecord;

  const validationResult = validateProjectPackage(packageRecord);
  if (validationResult.errors.length) {
    const failedProject = await projectRepository.markProjectValidationFailed(
      workingProject.id,
      packageRecord.packageVersion || PACKAGE_VERSION,
      packageRecord.schemaVersion || SCHEMA_VERSION
    );
    const failedPackage = await projectPackageRepository.upsertProjectPackage({
      projectId: packageRecord.projectId,
      quoteId: packageRecord.quoteId,
      packageVersion: packageRecord.packageVersion,
      schemaVersion: packageRecord.schemaVersion,
      status: "failed_validation",
      validationStatus: "failed_validation",
      validationErrors: validationResult.errors,
      storageManifest: packageRecord.storageManifest || {},
      packageKey: packageRecord.packageKey || null,
      packageUrl: packageRecord.packageUrl || null,
      packageGeneratedAt: getPackageGeneratedAt(packageRecord),
      sourceDomain: packageRecord.sourceDomain || (validationResult.manifest && validationResult.manifest.source_domain) || null,
      approvedPageCount: getApprovedPageCountFromPackage(packageRecord),
      buildJobId: packageRecord.buildJobId || null,
      submittedAt: null,
      manifest: packageRecord.manifest,
      files: packageRecord.files,
      snapshot: packageRecord.snapshot
    });
    const validationError = createPublishError(
      validationResult.errors[0] && validationResult.errors[0].message
        ? validationResult.errors[0].message
        : "Package validation failed.",
      400
    );
    validationError.validation = validationResult;
    validationError.project = failedProject;
    validationError.packageRecord = failedPackage;
    throw validationError;
  }

  try {
    let storageData = null;
    if (
      packageRecord.packageKey &&
      packageRecord.packageUrl &&
      packageRecord.validationStatus === "valid"
    ) {
      storageData = {
        packageKey: packageRecord.packageKey,
        packageUrl: packageRecord.packageUrl,
        storageManifest: packageRecord.storageManifest || {}
      };
    } else {
      storageData = await uploadProjectPackageBundle(workingProject, packageRecord, validationResult);
    }

    packageRecord = await projectPackageRepository.upsertProjectPackage({
      projectId: packageRecord.projectId,
      quoteId: packageRecord.quoteId,
      packageVersion: packageRecord.packageVersion,
      schemaVersion: packageRecord.schemaVersion,
      status: "uploaded",
      validationStatus: "valid",
      validationErrors: [],
      storageManifest: storageData.storageManifest || {},
      packageKey: storageData.packageKey,
      packageUrl: storageData.packageUrl,
      packageGeneratedAt: getPackageGeneratedAt(packageRecord),
      sourceDomain: packageRecord.sourceDomain || (validationResult.manifest && validationResult.manifest.source_domain) || null,
      approvedPageCount: getApprovedPageCountFromPackage(packageRecord),
      buildJobId: packageRecord.buildJobId || null,
      submittedAt: packageRecord.submittedAt || null,
      manifest: packageRecord.manifest,
      files: packageRecord.files,
      snapshot: packageRecord.snapshot
    });

    const buildJobResult = await ensureBuildJob(workingProject, packageRecord);
    const submittedAt = new Date().toISOString();

    packageRecord = await projectPackageRepository.upsertProjectPackage({
      projectId: packageRecord.projectId,
      quoteId: packageRecord.quoteId,
      packageVersion: packageRecord.packageVersion,
      schemaVersion: packageRecord.schemaVersion,
      status: "ready",
      validationStatus: "valid",
      validationErrors: [],
      storageManifest: packageRecord.storageManifest || {},
      packageKey: packageRecord.packageKey,
      packageUrl: packageRecord.packageUrl,
      packageGeneratedAt: getPackageGeneratedAt(packageRecord),
      sourceDomain: packageRecord.sourceDomain || (validationResult.manifest && validationResult.manifest.source_domain) || null,
      approvedPageCount: getApprovedPageCountFromPackage(packageRecord),
      buildJobId: buildJobResult.buildJob.id,
      submittedAt,
      manifest: packageRecord.manifest,
      files: packageRecord.files,
      snapshot: packageRecord.snapshot
    });

    workingProject = await projectRepository.markProjectSubmitted(
      workingProject.id,
      buildJobResult.buildJob.id,
      packageRecord.packageVersion || PACKAGE_VERSION,
      packageRecord.schemaVersion || SCHEMA_VERSION,
      getPackageGeneratedAt(packageRecord),
      submittedAt
    );

    const notificationSent = await sendInternalBuildReadyNotification(
      workingProject,
      packageRecord,
      buildJobResult.buildJob
    );

    return {
      project: workingProject,
      packageRecord,
      buildJob: buildJobResult.buildJob,
      packageSummary: buildPackageSummary(packageRecord, workingProject, buildJobResult.buildJob),
      reusedExistingPackage: Boolean(packageResult.reusedExistingPackage),
      reusedExistingJob: Boolean(buildJobResult.reusedExistingJob),
      notificationSent
    };
  } catch (error) {
    await projectRepository.markProjectPublishFailed(
      workingProject.id,
      packageRecord && packageRecord.packageVersion ? packageRecord.packageVersion : PACKAGE_VERSION,
      packageRecord && packageRecord.schemaVersion ? packageRecord.schemaVersion : SCHEMA_VERSION
    );
    console.error(
      "PROJECT_SUBMISSION_ERROR",
      workingProject.id,
      error && error.message ? error.message : error
    );
    throw error;
  }
}

module.exports = {
  PACKAGE_VERSION,
  SCHEMA_VERSION,
  ensureProjectPackageAssembled,
  publishProjectPackage: ensureProjectPackageAssembled,
  submitProjectForBuild
};
