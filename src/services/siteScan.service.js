const fs = require("fs");
const net = require("net");
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
    } catch (error) {
      console.error("SITE_SCAN_CRAWL_ERROR", nextUrl, error && error.message ? error.message : error);
    } finally {
      await page.close();
    }
  }

  return discovered;
}

async function buildScanPreviewDataUrl(page) {
  const screenshotBuffer = await page.screenshot({
    fullPage: true,
    type: "png"
  });
  const screenshotBase64 = screenshotBuffer.toString("base64");
  return `data:image/png;base64,${screenshotBase64}`;
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

    const discoveredLinks = await collectInternalLinks(browser, rootUrl, metadata.hrefs);
    const detectedPages = Math.max(1, discoveredLinks.size);

    const result = {
      siteUrl: normalizedUrl,
      siteTitle: metadata.title || rootUrl.hostname,
      siteDescription: metadata.description || "",
      previewImageUrl,
      detectedPages,
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
  scanSite
};
