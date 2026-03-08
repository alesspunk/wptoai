const fs = require("fs");
const fsPromises = require("fs/promises");
const net = require("net");
const path = require("path");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { extractUrl } = require("./quotePricingService");

const VIEWPORT = { width: 1366, height: 820 };
const MAX_CRAWL_PAGES = 4;
const MAX_DISCOVERED_LINKS = 200;

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

async function extractPageMetadata(page) {
  return page.evaluate(() => {
    const title = (document.querySelector("title") && document.querySelector("title").innerText) || "";
    const descriptionNode = document.querySelector('meta[name="description"]');
    const description = descriptionNode ? descriptionNode.getAttribute("content") || "" : "";

    const hrefs = Array.from(document.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") || "")
      .filter(Boolean);

    return {
      title: String(title || "").trim(),
      description: String(description || "").trim(),
      hrefs
    };
  });
}

async function launchBrowser() {
  const useServerlessChromium = process.platform === "linux";
  const executablePath = useServerlessChromium
    ? process.env.PUPPETEER_EXECUTABLE_PATH || (await chromium.executablePath())
    : resolveLocalExecutablePath();

  return puppeteer.launch({
    args: useServerlessChromium ? chromium.args : ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: VIEWPORT,
    executablePath: executablePath || undefined,
    headless: useServerlessChromium ? chromium.headless : true,
    ignoreHTTPSErrors: true
  });
}

async function collectInternalLinks(browser, rootUrl, initialLinks) {
  const discovered = new Set();
  discovered.add(`${rootUrl.origin}${rootUrl.pathname === "/" ? "/" : rootUrl.pathname.replace(/\/$/, "")}`);

  const queue = [];
  initialLinks.forEach((href) => {
    const normalized = normalizeInternalLink(href, rootUrl);
    if (!normalized || discovered.has(normalized)) return;
    discovered.add(normalized);
    queue.push(normalized);
  });

  let crawled = 0;

  while (queue.length > 0 && crawled < MAX_CRAWL_PAGES && discovered.size < MAX_DISCOVERED_LINKS) {
    const nextUrl = queue.shift();
    if (!nextUrl) continue;
    crawled += 1;

    const page = await browser.newPage();
    try {
      await page.goto(nextUrl, {
        waitUntil: "networkidle2",
        timeout: 30000
      });
      const data = await extractPageMetadata(page);
      data.hrefs.forEach((href) => {
        const normalized = normalizeInternalLink(href, rootUrl);
        if (!normalized || discovered.has(normalized) || discovered.size >= MAX_DISCOVERED_LINKS) return;
        discovered.add(normalized);
        if (queue.length + crawled < MAX_CRAWL_PAGES) {
          queue.push(normalized);
        }
      });
    } catch (_error) {
    } finally {
      await page.close();
    }
  }

  return discovered;
}

async function saveScanImages(page, timestamp) {
  const scansDir = path.join(process.cwd(), "public", "scans");
  await fsPromises.mkdir(scansDir, { recursive: true });

  const fullFilename = `scan-${timestamp}-full.png`;
  const previewFilename = `scan-${timestamp}.png`;
  const fullPath = path.join(scansDir, fullFilename);
  const previewPath = path.join(scansDir, previewFilename);

  const fullBuffer = await page.screenshot({
    fullPage: true,
    type: "png"
  });
  await fsPromises.writeFile(fullPath, fullBuffer);

  const viewport = page.viewport() || VIEWPORT;
  const previewBuffer = await page.screenshot({
    type: "png",
    clip: {
      x: 0,
      y: 0,
      width: Math.floor(viewport.width || VIEWPORT.width),
      height: Math.floor(viewport.height || VIEWPORT.height)
    }
  });
  await fsPromises.writeFile(previewPath, previewBuffer);

  return {
    fullImageUrl: `/scans/${fullFilename}`,
    previewImageUrl: `/scans/${previewFilename}`
  };
}

async function scanSite(inputUrl) {
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
    const timestamp = Date.now();
    const images = await saveScanImages(page, timestamp);

    const discoveredLinks = await collectInternalLinks(browser, rootUrl, metadata.hrefs);
    const detectedPages = Math.max(1, discoveredLinks.size);

    return {
      siteUrl: normalizedUrl,
      siteTitle: metadata.title || rootUrl.hostname,
      siteDescription: metadata.description || "",
      previewImageUrl: images.previewImageUrl,
      detectedPages,
      scanStatus: "completed"
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  scanSite
};
