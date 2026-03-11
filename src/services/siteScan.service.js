const fs = require("fs");
const net = require("net");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { extractUrl } = require("./quotePricingService");

const VIEWPORT = { width: 1366, height: 820 };
const MAX_CRAWL_PAGES = 4;
const MAX_DISCOVERED_LINKS = 200;
const STRONG_SECTION_PATTERNS = [
  { label: "Hero", pattern: /\b(hero|banner|masthead|intro|headline)\b/i },
  { label: "Services", pattern: /\b(service|services|capabilities|solutions|offerings)\b/i },
  { label: "Features", pattern: /\b(feature|features|benefits|advantages)\b/i },
  { label: "About", pattern: /\b(about|our story|company)\b/i },
  { label: "Team", pattern: /\b(team|leadership|staff)\b/i },
  { label: "Portfolio", pattern: /\b(portfolio|projects|case stud(?:y|ies)|our work)\b/i },
  { label: "Testimonials", pattern: /\b(testimonial|testimonials|reviews|clients say)\b/i },
  { label: "Pricing", pattern: /\b(pricing|plans|packages)\b/i },
  { label: "FAQ", pattern: /\b(faq|questions)\b/i },
  { label: "Contact", pattern: /\b(contact|get in touch|consultation|appointment|book now)\b/i },
  { label: "Footer", pattern: /\bfooter\b/i }
];

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const lower = String(hostname).toLowerCase();
  if (lower === "localhost" || lower === "::1") return true;
  if (lower.includes(":")) return true;

  const ipType = net.isIP(lower);
  if (ipType === 4) {
    const parts = lower.split(".").map((part) => parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
      return true;
    }
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }

  return false;
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

function normalizeInternalLink(rawHref, rootUrl) {
  if (!rawHref) return "";
  try {
    const parsed = new URL(rawHref, rootUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    if (parsed.hostname !== rootUrl.hostname) return "";
    parsed.hash = "";
    parsed.search = "";
    let pathname = parsed.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${parsed.origin}${pathname}`;
  } catch (_error) {
    return "";
  }
}

function humanizeSlugSegment(value) {
  const cleaned = String(value || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildReadableTitleFromUrl(pageUrl, isHomepage) {
  if (isHomepage) return "Home";
  try {
    const parsed = new URL(pageUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (!segments.length) return "Home";
    const label = humanizeSlugSegment(segments[segments.length - 1]);
    return label || "Untitled Page";
  } catch (_error) {
    return "Untitled Page";
  }
}

function normalizeDetectedTitle(title, pageUrl, isHomepage) {
  const normalized = String(title || "").replace(/\s+/g, " ").trim();
  if (normalized) return normalized;
  return buildReadableTitleFromUrl(pageUrl, isHomepage);
}

async function extractPageMetadata(page) {
  return page.evaluate(() => {
    const title = (document.querySelector("title") && document.querySelector("title").innerText) || "";
    const descriptionNode = document.querySelector('meta[name="description"]');
    const description = descriptionNode ? descriptionNode.getAttribute("content") || "" : "";

    const hrefs = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") || "")
      .filter(Boolean);

    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 18);

    const clueText = Array.from(document.querySelectorAll("section, article, nav, footer, form, main, [class], [id]"))
      .slice(0, 220)
      .map((node) => {
        const className = typeof node.className === "string" ? node.className : "";
        const id = node.id || "";
        return [node.tagName || "", className, id].join(" ");
      })
      .join(" ");

    const semanticCounts = {
      section: document.querySelectorAll("section").length,
      article: document.querySelectorAll("article").length,
      nav: document.querySelectorAll("nav").length,
      footer: document.querySelectorAll("footer").length,
      form: document.querySelectorAll("form").length
    };

    return {
      title: String(title || "").trim(),
      description: String(description || "").trim(),
      hrefs,
      headings,
      clueText: String(clueText || ""),
      semanticCounts
    };
  });
}

function normalizePredictedSectionLabel(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function isUsefulHeading(heading, pageTitle) {
  const normalized = String(heading || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (normalized.length < 3 || normalized.length > 64) return false;
  if (/^(home|homepage|welcome)$/i.test(normalized)) return false;
  if (pageTitle && normalized.toLowerCase() === String(pageTitle).toLowerCase()) return false;
  return true;
}

function predictPageSections(metadata, pageUrl, isHomepage) {
  const predicted = [];
  const seen = new Set();
  const pageTitle = normalizeDetectedTitle(metadata && metadata.title, pageUrl, isHomepage);
  const headings = Array.isArray(metadata && metadata.headings) ? metadata.headings : [];
  const semanticCounts = metadata && metadata.semanticCounts ? metadata.semanticCounts : {};
  const clueText = [
    pageTitle,
    metadata && metadata.description ? metadata.description : "",
    headings.join(" "),
    metadata && metadata.clueText ? metadata.clueText : ""
  ].join(" ");

  function addSection(label) {
    const normalized = normalizePredictedSectionLabel(label);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return;
    seen.add(key);
    predicted.push(normalized);
  }

  STRONG_SECTION_PATTERNS.forEach((entry) => {
    if (entry.pattern.test(clueText)) {
      addSection(entry.label);
    }
  });

  headings
    .filter((heading) => isUsefulHeading(heading, pageTitle))
    .slice(0, 5)
    .forEach(addSection);

  if (semanticCounts && Number(semanticCounts.form || 0) > 0) {
    addSection("Contact Form");
  }
  if (semanticCounts && Number(semanticCounts.footer || 0) > 0) {
    addSection("Footer");
  }
  if (isHomepage && headings.length > 0) {
    addSection("Hero");
  }

  const confidenceScore = predicted.length +
    (Number(semanticCounts.form || 0) > 0 ? 1 : 0) +
    (Number(semanticCounts.section || 0) >= 2 ? 1 : 0);

  if (confidenceScore < 2) {
    return [];
  }

  return predicted.slice(0, 6);
}

async function launchBrowser() {
  const isVercelRuntime = Boolean(process.env.VERCEL);
  const useServerlessChromium = isVercelRuntime || process.platform === "linux";
  const executablePath = useServerlessChromium
    ? await chromium.executablePath()
    : resolveLocalExecutablePath();

  return puppeteer.launch({
    args: useServerlessChromium ? chromium.args : ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: VIEWPORT,
    executablePath: executablePath || undefined,
    headless: useServerlessChromium ? true : true,
    ignoreHTTPSErrors: true
  });
}

async function discoverSitePages(browser, rootUrl, homepageMetadata) {
  const homepageUrl = `${rootUrl.origin}${rootUrl.pathname === "/" ? "/" : rootUrl.pathname.replace(/\/$/, "")}`;
  const discovered = new Map();
  discovered.set(homepageUrl, {
    url: homepageUrl,
    title: normalizeDetectedTitle(homepageMetadata && homepageMetadata.title, homepageUrl, true),
    predictedSections: predictPageSections(homepageMetadata, homepageUrl, true)
  });

  const queue = [];
  const crawledUrls = new Set();

  const initialLinks = Array.isArray(homepageMetadata && homepageMetadata.hrefs)
    ? homepageMetadata.hrefs
    : [];
  initialLinks.forEach((href) => {
    const normalized = normalizeInternalLink(href, rootUrl);
    if (!normalized || discovered.has(normalized)) return;
    discovered.set(normalized, {
      url: normalized,
      title: buildReadableTitleFromUrl(normalized, false),
      predictedSections: []
    });
    queue.push(normalized);
  });

  let crawled = 0;

  while (queue.length > 0 && crawled < MAX_CRAWL_PAGES && discovered.size < MAX_DISCOVERED_LINKS) {
    const nextUrl = queue.shift();
    if (!nextUrl || crawledUrls.has(nextUrl)) continue;
    crawledUrls.add(nextUrl);
    crawled += 1;

    const page = await browser.newPage();
    try {
      await page.goto(nextUrl, {
        waitUntil: "networkidle2",
        timeout: 30000
      });
      const data = await extractPageMetadata(page);
      discovered.set(nextUrl, {
        url: nextUrl,
        title: normalizeDetectedTitle(data && data.title, nextUrl, false),
        predictedSections: predictPageSections(data, nextUrl, false)
      });
      data.hrefs.forEach((href) => {
        if (discovered.size >= MAX_DISCOVERED_LINKS) return;
        const normalized = normalizeInternalLink(href, rootUrl);
        if (!normalized || discovered.has(normalized)) return;
        discovered.set(normalized, {
          url: normalized,
          title: buildReadableTitleFromUrl(normalized, false),
          predictedSections: []
        });
        if (queue.length + crawled < MAX_CRAWL_PAGES) {
          queue.push(normalized);
        }
      });
    } catch (error) {
      console.error("SITE_SCAN_CRAWL_ERROR", nextUrl, error && error.message ? error.message : error);
    } finally {
      await page.close();
    }
  }

  return Array.from(discovered.values()).slice(0, MAX_DISCOVERED_LINKS);
}

async function buildScanPreviewDataUrl(page) {
  const screenshotBuffer = await page.screenshot({
    fullPage: true,
    type: "png"
  });
  const screenshotBase64 = screenshotBuffer.toString("base64");
  return `data:image/png;base64,${screenshotBase64}`;
}

async function capturePageScreenshot(page) {
  return page.screenshot({
    fullPage: true,
    type: "jpeg",
    quality: 72
  });
}

async function captureSitePage(inputUrl) {
  const normalizedUrl = extractUrl(inputUrl || "");
  if (!normalizedUrl) {
    throw new Error("Invalid siteUrl.");
  }

  const rootUrl = new URL(normalizedUrl);
  const allowPrivateHosts = process.env.ALLOW_PRIVATE_PREVIEW_HOSTS === "true";
  if (!allowPrivateHosts && isPrivateHost(rootUrl.hostname)) {
    throw new Error("Private host scanning is not allowed.");
  }

  let browser;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(normalizedUrl, {
      waitUntil: "networkidle2",
      timeout: 45000
    });

    const metadata = await extractPageMetadata(page);
    const screenshotBuffer = await capturePageScreenshot(page);

    return {
      url: normalizedUrl,
      title: normalizeDetectedTitle(metadata && metadata.title, normalizedUrl, rootUrl.pathname === "/"),
      description: metadata && metadata.description ? metadata.description : "",
      screenshotBuffer,
      contentType: "image/jpeg"
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function scanSite(inputUrl) {
  console.log("SITE_SCAN_START");
  const normalizedUrl = extractUrl(inputUrl || "");
  console.log("SITE_SCAN_URL", normalizedUrl || String(inputUrl || ""));
  if (!normalizedUrl) {
    throw new Error("Invalid siteUrl.");
  }

  const rootUrl = new URL(normalizedUrl);
  const allowPrivateHosts = process.env.ALLOW_PRIVATE_PREVIEW_HOSTS === "true";
  if (!allowPrivateHosts && isPrivateHost(rootUrl.hostname)) {
    throw new Error("Private host scanning is not allowed.");
  }

  let browser;

  try {
    browser = await launchBrowser();
    console.log("SITE_SCAN_BROWSER_OK");
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(normalizedUrl, {
      waitUntil: "networkidle2",
      timeout: 45000
    });
    console.log("SITE_SCAN_PAGE_OK");

    const metadata = await extractPageMetadata(page);
    console.log("SITE_SCAN_METADATA_OK");
    const previewImageUrl = await buildScanPreviewDataUrl(page);
    console.log("SITE_SCAN_SCREENSHOT_OK");

    const discoveredPages = await discoverSitePages(browser, rootUrl, metadata);
    const detectedPages = Math.max(1, discoveredPages.length);

    const result = {
      siteUrl: normalizedUrl,
      siteTitle: metadata.title || rootUrl.hostname,
      siteDescription: metadata.description || "",
      previewImageUrl,
      detectedPages,
      detectedPagesData: discoveredPages.map((item, index) => ({
        url: item.url,
        title: normalizeDetectedTitle(item.title, item.url, index === 0),
        type: index === 0 ? "homepage" : "page",
        orderIndex: index,
        predictedSections: Array.isArray(item.predictedSections) ? item.predictedSections : []
      })),
      scanStatus: "completed"
    };
    console.log("SITE_SCAN_DONE", JSON.stringify({
      siteUrl: result.siteUrl,
      detectedPages: result.detectedPages,
      previewImageUrl: result.previewImageUrl
    }));
    return result;
  } catch (error) {
    console.error("SITE_SCAN_ERROR", error && error.message ? error.message : error);
    console.error("SITE_SCAN_ERROR_STACK", error && error.stack ? error.stack : "");
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  scanSite,
  captureSitePage,
  buildReadableTitleFromUrl,
  normalizeDetectedTitle
};
