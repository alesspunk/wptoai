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

async function extractStructuredData(page) {
  try {
    return await page.evaluate((viewport) => {
      const MAX_TOTAL_NODES = 200;
      const MAX_SECTIONS = 12;
      const MAX_ASSET_REFS = 10;
      let processedNodes = 0;

      function normalizeText(value, maxLength) {
        const normalized = String(value || "").replace(/\s+/g, " ").trim();
        if (!normalized) return "";
        if (!maxLength || normalized.length <= maxLength) return normalized;
        return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
      }

      function toNumber(value) {
        const parsed = parseFloat(String(value || ""));
        return Number.isFinite(parsed) ? parsed : 0;
      }

      function roundToStep(value, step) {
        if (!Number.isFinite(value) || value <= 0) return "";
        return `${Math.round(value / step) * step}px`;
      }

      function normalizeColor(value) {
        const normalized = String(value || "").trim().toLowerCase();
        if (isTransparentColor(normalized)) return "";
        if (/^#([0-9a-f]{3}){1,2}$/i.test(normalized)) {
          if (normalized.length === 4) {
            return `#${normalized.slice(1).split("").map((part) => part + part).join("")}`;
          }
          return normalized;
        }

        const rgbaMatch = normalized.match(/^rgba?\(([^)]+)\)$/i);
        if (!rgbaMatch) return normalized;

        const parts = rgbaMatch[1].split(",").map((part) => part.trim());
        if (parts.length < 3) return normalized;
        const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1;
        if (!Number.isFinite(alpha) || alpha <= 0) return "";

        const rgb = parts.slice(0, 3).map((part) => {
          const numeric = Math.max(0, Math.min(255, Math.round(parseFloat(part))));
          return Number.isFinite(numeric) ? numeric : 0;
        });

        return `#${rgb.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
      }

      function normalizeFontFamily(value) {
        const families = String(value || "")
          .split(",")
          .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
        if (!families.length) return "";
        const preferred = families.find((part) => !/^(serif|sans-serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|inherit|initial|unset)$/i.test(part));
        return preferred || families[0] || "";
      }

      function classifyFontStyle(weightValue) {
        const numericWeight = toNumber(weightValue);
        return numericWeight >= 600 ? "bold" : "regular";
      }

      function classifyRadius(radiusValue) {
        if (!Number.isFinite(radiusValue) || radiusValue <= 0) return "none";
        if (radiusValue <= 6) return "small";
        if (radiusValue <= 14) return "medium";
        return "large";
      }

      function addColorWeight(target, color, weight) {
        const normalized = normalizeColor(color);
        if (!normalized) return;
        target.set(normalized, (target.get(normalized) || 0) + (weight || 1));
      }

      function pickRankedColors(target) {
        return Array.from(target.entries())
          .sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1])
          .map((entry) => entry[0]);
      }

      function isTransparentColor(value) {
        const normalized = String(value || "").trim().toLowerCase();
        return !normalized ||
          normalized === "transparent" ||
          normalized === "rgba(0, 0, 0, 0)" ||
          normalized === "rgba(0,0,0,0)";
      }

      function getStyle(node) {
        try {
          return window.getComputedStyle(node);
        } catch (_error) {
          return null;
        }
      }

      function isIgnoredElement(node) {
        if (!node || !node.tagName) return true;
        return /^(script|style|noscript|template|link|meta)$/i.test(node.tagName);
      }

      function isElementVisible(node) {
        if (!node || isIgnoredElement(node)) return false;
        const style = getStyle(node);
        if (!style) return false;
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
          return false;
        }
        if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
        const rect = node.getBoundingClientRect();
        return rect.width >= 2 && rect.height >= 2;
      }

      function getRect(node) {
        try {
          return node.getBoundingClientRect();
        } catch (_error) {
          return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
        }
      }

      function getDirectVisibleChildren(node, limit) {
        if (!node || !node.children) return [];
        const output = [];
        const children = Array.from(node.children);
        for (let index = 0; index < children.length; index += 1) {
          if (processedNodes >= MAX_TOTAL_NODES || output.length >= limit) break;
          processedNodes += 1;
          const child = children[index];
          if (!isElementVisible(child)) continue;
          output.push(child);
        }
        return output;
      }

      function hasDirectText(node) {
        if (!node || !node.childNodes) return false;
        return Array.from(node.childNodes).some((child) => (
          child &&
          child.nodeType === Node.TEXT_NODE &&
          normalizeText(child.textContent || "", 60)
        ));
      }

      function unwrapDominantChild(node) {
        if (!node) return node;
        const rect = getRect(node);
        const visibleChildren = getDirectVisibleChildren(node, 8);
        if (!visibleChildren.length || hasDirectText(node)) return node;

        const candidate = visibleChildren.find((child) => {
          const childRect = getRect(child);
          return childRect.width >= rect.width * 0.72 && childRect.height >= rect.height * 0.72;
        });

        return candidate || node;
      }

      function hasRenderableContent(node) {
        if (!node) return false;
        if (normalizeText(node.innerText || "", 280)) return true;
        if (node.querySelector("img, picture, svg, button, a")) return true;
        return false;
      }

      function isLargeSectionCandidate(node) {
        if (!node || !isElementVisible(node)) return false;
        const rect = getRect(node);
        const tagName = String(node.tagName || "").toLowerCase();
        const textPreview = normalizeText(node.innerText || "", 160);
        const isTopBand = rect.top <= viewport.height * 0.28;
        const hasCompactTopBandContent = isTopBand &&
          rect.height >= 36 &&
          rect.height <= 110 &&
          (
            textPreview.length >= 4 ||
            Boolean(node.querySelector("a[href], button, input, [role='button'], img, svg"))
          );
        const minimumHeight = /^(header|nav)$/i.test(tagName)
          ? 72
          : (hasCompactTopBandContent ? 36 : 120);
        if (rect.height < minimumHeight || rect.width < 180) return false;
        if (!hasRenderableContent(node)) return false;
        return true;
      }

      function collectSectionCandidates() {
        if (!document.body) return [];

        let candidates = getDirectVisibleChildren(document.body, 24)
          .map((node) => unwrapDominantChild(node));

        if (candidates.length === 1) {
          const wrapperChildren = getDirectVisibleChildren(candidates[0], 16)
            .map((node) => unwrapDominantChild(node));
          const substantialChildren = wrapperChildren.filter((node) => isLargeSectionCandidate(node));
          if (substantialChildren.length >= 2) {
            candidates = substantialChildren;
          }
        }

        const output = [];
        const seenKeys = new Set();
        for (let index = 0; index < candidates.length; index += 1) {
          if (processedNodes >= MAX_TOTAL_NODES || output.length >= MAX_SECTIONS) break;
          const node = candidates[index];
          if (!isLargeSectionCandidate(node)) continue;
          const rect = getRect(node);
          const key = [
            String(node.tagName || "").toLowerCase(),
            Math.round(rect.top),
            Math.round(rect.height),
            Math.round(rect.width)
          ].join(":");
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          output.push(node);
        }

        return output
          .sort((leftNode, rightNode) => {
            const leftRect = getRect(leftNode);
            const rightRect = getRect(rightNode);
            if (Math.abs(leftRect.top - rightRect.top) > 16) {
              return leftRect.top - rightRect.top;
            }
            return leftRect.left - rightRect.left;
          })
          .slice(0, MAX_SECTIONS);
      }

      function queryVisible(node, selector, limit, predicate) {
        if (!node || processedNodes >= MAX_TOTAL_NODES) return [];
        const matches = node.querySelectorAll(selector);
        const output = [];
        for (let index = 0; index < matches.length; index += 1) {
          if (processedNodes >= MAX_TOTAL_NODES || output.length >= limit) break;
          processedNodes += 1;
          const match = matches[index];
          if (!isElementVisible(match)) continue;
          if (predicate && !predicate(match)) continue;
          output.push(match);
        }
        return output;
      }

      function findFirstText(node, selectors, limit) {
        const matches = queryVisible(node, selectors, limit || 6, (match) => normalizeText(match.innerText || "", 200));
        for (let index = 0; index < matches.length; index += 1) {
          const text = normalizeText(matches[index].innerText || "", 200);
          if (text) return text;
        }
        return "";
      }

      function findFirstCta(node) {
        const matches = queryVisible(
          node,
          "a[href], button, input[type='button'], input[type='submit']",
          8,
          (match) => {
            const text = normalizeText(
              match.innerText || match.value || match.getAttribute("aria-label") || "",
              80
            );
            return text.length >= 2;
          }
        );
        for (let index = 0; index < matches.length; index += 1) {
          const match = matches[index];
          const text = normalizeText(
            match.innerText || match.value || match.getAttribute("aria-label") || "",
            200
          );
          if (text) return text;
        }
        return "";
      }

      function collectVisibleLabels(node, limit) {
        const matches = queryVisible(
          node,
          "a[href], button, [role='button'], h3, h4, h5, li",
          Math.max(6, limit * 2),
          (match) => {
            const text = normalizeText(
              match.innerText || match.textContent || match.getAttribute("aria-label") || "",
              80
            );
            return text.length >= 2 && text.length <= 60;
          }
        );
        const labels = [];
        const seen = new Set();
        matches.forEach((match) => {
          if (labels.length >= limit) return;
          const text = normalizeText(
            match.innerText || match.textContent || match.getAttribute("aria-label") || "",
            80
          );
          const key = text.toLowerCase();
          if (!text || seen.has(key)) return;
          seen.add(key);
          labels.push(text);
        });
        return labels;
      }

      function inferColumns(node) {
        const layoutRoot = unwrapDominantChild(node);
        const children = getDirectVisibleChildren(layoutRoot, 10).filter((child) => {
          const rect = getRect(child);
          return rect.width >= 100 && rect.height >= 40;
        });

        if (!children.length) return 1;

        const leftGroups = [];
        children.forEach((child) => {
          const left = getRect(child).left;
          const existing = leftGroups.find((value) => Math.abs(value - left) < 56);
          if (existing === undefined) {
            leftGroups.push(left);
          }
        });

        return Math.max(1, Math.min(4, leftGroups.length || 1));
      }

      function inferRepeatedBlocks(node) {
        const layoutRoot = unwrapDominantChild(node);
        const children = getDirectVisibleChildren(layoutRoot, 10).filter((child) => {
          const rect = getRect(child);
          return rect.width >= 90 && rect.height >= 40;
        });
        return children.length;
      }

      function inferLayoutLabel(columns, repeatedBlocks) {
        if (repeatedBlocks >= 3 && columns >= 2) return "grid";
        if (columns >= 2) return "side-by-side";
        return "stacked";
      }

      function inferTextDensity(node) {
        const length = normalizeText(node.innerText || "", 1200).length;
        if (length >= 500) return "high";
        if (length >= 180) return "medium";
        return "low";
      }

      function inferCentered(node) {
        const rect = getRect(node);
        const style = getStyle(node);
        if (style && style.textAlign === "center") return true;
        const centerOffset = Math.abs((rect.left + rect.width / 2) - viewport.width / 2);
        return centerOffset <= viewport.width * 0.12;
      }

      function countVisibleLinks(node) {
        return queryVisible(node, "a[href]", 12, (match) => normalizeText(match.innerText || "", 80)).length;
      }

      function buildSectionSignals(node, sectionInfo) {
        const clueText = normalizeText([
          node.id || "",
          typeof node.className === "string" ? node.className : "",
          node.getAttribute("role") || "",
          node.getAttribute("aria-label") || ""
        ].join(" "), 260).toLowerCase();
        const textSample = normalizeText(node.innerText || "", 600);
        const labels = collectVisibleLabels(node, 6);
        const textBlob = [clueText, textSample, labels.join(" ")].join(" ").toLowerCase();
        const mediaNodes = queryVisible(node, "img, svg", 10, () => true);
        let imageCount = 0;
        let iconLikeCount = 0;
        mediaNodes.forEach((mediaNode) => {
          const rect = getRect(mediaNode);
          if (rect.width >= 48 || rect.height >= 48) imageCount += 1;
          if (rect.width <= 72 && rect.height <= 72) iconLikeCount += 1;
        });

        const hasSearch = Boolean(queryVisible(
          node,
          "input, form, [role='search']",
          4,
          (match) => {
            const role = String(match.getAttribute("role") || "").toLowerCase();
            const type = String(match.getAttribute("type") || "").toLowerCase();
            const placeholder = normalizeText(match.getAttribute("placeholder") || "", 40).toLowerCase();
            return role === "search" || type === "search" || placeholder.includes("search");
          }
        ).length);

        return {
          clueText,
          textSample,
          labels,
          imageCount,
          iconLikeCount,
          hasSearch,
          hasAnnouncementKeywords: /\b(free shipping|shipping|limited time|promo(?:tion)?|sale|save|off|returns|new arrivals?)\b/.test(textBlob),
          hasUtilityKeywords: /\b(account|sign in|sign-in|login|log in|register|wishlist|store locator|help|support|search|cart|bag|checkout|my account)\b/.test(textBlob),
          hasCategoryKeywords: /\b(shop|men|women|kids|collections?|category|categories|brands|sale|new arrivals?|gifts?)\b/.test(textBlob),
          hasProductKeywords: /\b(add to cart|quick view|buy now|price|product|sku|\$\s?\d|£\s?\d|€\s?\d)\b/.test(textBlob),
          hasEditorialKeywords: /\b(blog|journal|editorial|article|stories|story|read more)\b/.test(textBlob),
          hasPromoKeywords: /\b(save|sale|off|limited time|free shipping|shop now|discover|learn more|new collection|spring|summer|fall|winter)\b/.test(textBlob),
          hasBrandStoryKeywords: /\b(our story|about us|heritage|craft|mission|brand story|who we are)\b/.test(textBlob),
          topRegion: sectionInfo.rect.top <= viewport.height * 0.32,
          shortTopBand: sectionInfo.rect.top <= viewport.height * 0.32 && sectionInfo.rect.height <= 110,
          hasHorizontalOverflow: Boolean(node && node.scrollWidth > node.clientWidth + 48)
        };
      }

      function classifySection(node, index, total, sectionInfo, sectionSignals) {
        const tag = String(node.tagName || "").toLowerCase();
        const clueText = sectionSignals && sectionSignals.clueText ? sectionSignals.clueText : "";
        const linkCount = Number(sectionInfo && sectionInfo.linkCount ? sectionInfo.linkCount : 0);
        const isHeaderLike = tag === "header" || tag === "nav" || /\b(header|nav|menu)\b/.test(clueText);

        if (
          tag === "header" ||
          tag === "nav" ||
          /\b(header|nav|menu)\b/.test(clueText) ||
          (index === 0 && linkCount >= 3 && sectionInfo.rect.top < viewport.height * 0.4)
        ) {
          if (sectionSignals && sectionSignals.shortTopBand) {
            if (
              !sectionInfo.hasImage &&
              !sectionSignals.hasSearch &&
              !sectionSignals.hasUtilityKeywords &&
              linkCount <= 2 &&
              (sectionSignals.hasAnnouncementKeywords || (sectionSignals.textSample.length <= 140 && linkCount <= 1))
            ) {
              return "announcement-bar";
            }

            if (sectionSignals.hasSearch || sectionSignals.hasUtilityKeywords) {
              return "utility-nav";
            }

            if (isHeaderLike || linkCount >= 4 || sectionSignals.hasCategoryKeywords) {
              return "primary-nav";
            }
          }

          return "header";
        }

        if (
          tag === "footer" ||
          /\bfooter\b/.test(clueText) ||
          (index === total - 1 && linkCount >= 3 && sectionInfo.rect.height >= 120)
        ) {
          return "footer";
        }

        if (
          sectionSignals &&
          sectionSignals.topRegion &&
          sectionSignals.shortTopBand &&
          (sectionSignals.hasSearch || sectionSignals.hasUtilityKeywords)
        ) {
          return "utility-nav";
        }

        if (
          sectionSignals &&
          sectionSignals.topRegion &&
          (isHeaderLike || linkCount >= 4)
        ) {
          return "primary-nav";
        }

        if (
          index <= 2 &&
          sectionInfo.heading &&
          sectionInfo.rect.height >= 240 &&
          sectionInfo.hasImage &&
          sectionInfo.approxColumns >= 2
        ) {
          return "hero-split";
        }

        if (
          index <= 1 &&
          sectionInfo.heading &&
          sectionInfo.rect.height >= 220 &&
          (sectionInfo.hasCTA || sectionInfo.hasImage)
        ) {
          return "hero";
        }

        if (
          sectionSignals &&
          sectionInfo.repeatedBlocks >= 4 &&
          sectionInfo.rect.height <= 260 &&
          (sectionSignals.hasCategoryKeywords || linkCount >= 4) &&
          (sectionInfo.approxColumns >= 3 || sectionSignals.labels.length >= 4)
        ) {
          return "category-strip";
        }

        if (
          sectionSignals &&
          sectionInfo.repeatedBlocks >= 3 &&
          sectionSignals.imageCount >= 2 &&
          sectionSignals.hasProductKeywords
        ) {
          return sectionSignals.hasHorizontalOverflow ? "product-carousel" : "product-grid";
        }

        if (
          sectionSignals &&
          sectionInfo.repeatedBlocks >= 2 &&
          sectionInfo.approxColumns >= 2 &&
          sectionSignals.hasEditorialKeywords
        ) {
          return "editorial-grid";
        }

        if (
          sectionSignals &&
          sectionInfo.repeatedBlocks >= 3 &&
          sectionSignals.iconLikeCount >= 3 &&
          sectionInfo.rect.height <= 320 &&
          !sectionSignals.hasProductKeywords
        ) {
          return "feature-icons";
        }

        if (
          sectionInfo.approxColumns >= 2 &&
          sectionInfo.hasCTA &&
          sectionInfo.repeatedBlocks >= 2 &&
          sectionInfo.rect.height <= 420
        ) {
          return "multi-column-cta";
        }

        if (
          sectionSignals &&
          sectionSignals.hasPromoKeywords &&
          (sectionInfo.hasCTA || sectionInfo.hasImage) &&
          sectionInfo.textDensity !== "high"
        ) {
          return "promo-banner";
        }

        if (
          sectionSignals &&
          sectionSignals.hasBrandStoryKeywords &&
          sectionInfo.textDensity !== "low"
        ) {
          return "brand-story";
        }

        if (sectionInfo.approxLayout === "grid" || (sectionInfo.approxColumns >= 2 && sectionInfo.repeatedBlocks >= 3)) {
          return "grid";
        }

        return "section";
      }

      function collectSectionContent(node, sectionId, sectionType, sectionInfo, sectionSignals) {
        const heading = sectionInfo && sectionInfo.heading ? sectionInfo.heading : findFirstText(node, "h1, h2, h3", 6);
        const subheading = findFirstText(node, "p, h4, h5, h6", 8);
        const cta = sectionInfo && sectionInfo.ctaText ? sectionInfo.ctaText : findFirstCta(node);
        const paragraphMatches = queryVisible(node, "p", 8, (match) => normalizeText(match.innerText || "", 200));
        const paragraphTexts = paragraphMatches
          .map((match) => normalizeText(match.innerText || "", 200))
          .filter(Boolean);
        const supportingText = paragraphTexts.find((text) => text && text !== subheading) || "";

        const content = {};
        if (heading) content.heading = heading;
        if (subheading) content.subheading = subheading;
        if (cta) content.cta = cta;
        if (supportingText) content.supportingText = supportingText;
        if (
          sectionSignals &&
          Array.isArray(sectionSignals.labels) &&
          sectionSignals.labels.length >= 2 &&
          /^(announcement-bar|utility-nav|primary-nav|category-strip|product-grid|product-carousel|feature-icons|editorial-grid)$/i.test(sectionType || "")
        ) {
          content.labels = sectionSignals.labels.slice(0, 6);
        }

        return Object.keys(content).length ? { [sectionId]: content } : null;
      }

      function pickAccentColor(bodyStyle) {
        const candidates = queryVisible(
          document.body,
          "a[href], button, [role='button'], input[type='button'], input[type='submit']",
          20,
          () => true
        );
        const bodyTextColor = bodyStyle ? String(bodyStyle.color || "") : "";
        const bodyBackgroundColor = bodyStyle ? String(bodyStyle.backgroundColor || "") : "";
        const weights = new Map();

        candidates.forEach((node) => {
          const style = getStyle(node);
          if (!style) return;
          const colors = [style.backgroundColor, style.color];
          colors.forEach((color) => {
            if (isTransparentColor(color)) return;
            if (color === bodyTextColor || color === bodyBackgroundColor) return;
            weights.set(color, (weights.get(color) || 0) + 1);
          });
        });

        let bestColor = "";
        let bestWeight = 0;
        weights.forEach((weight, color) => {
          if (weight > bestWeight) {
            bestColor = color;
            bestWeight = weight;
          }
        });
        return bestColor;
      }

      function collectVisualTokens(sectionNodes) {
        if (!document.body) return {};
        const bodyStyle = getStyle(document.body);
        const colors = {};
        const typography = {};
        const shape = {};

        if (bodyStyle && !isTransparentColor(bodyStyle.backgroundColor)) {
          colors.background = bodyStyle.backgroundColor;
        }
        if (bodyStyle && !isTransparentColor(bodyStyle.color)) {
          colors.text = bodyStyle.color;
        }

        const accent = pickAccentColor(bodyStyle);
        if (accent) colors.accent = accent;

        if (bodyStyle && bodyStyle.fontFamily) typography.fontFamily = normalizeText(bodyStyle.fontFamily, 120);
        if (bodyStyle && bodyStyle.fontSize) typography.baseFontSize = bodyStyle.fontSize;

        const firstHeading = findFirstText(document.body, "h1, h2, h3", 8);
        if (firstHeading) {
          const headingNode = queryVisible(document.body, "h1, h2, h3", 1, (match) => normalizeText(match.innerText || "", 120))[0];
          const headingStyle = headingNode ? getStyle(headingNode) : null;
          const headingSize = headingStyle ? toNumber(headingStyle.fontSize) : 0;
          const baseSize = bodyStyle ? toNumber(bodyStyle.fontSize) : 0;
          const scale = baseSize > 0 ? headingSize / baseSize : 0;
          if (scale >= 2.2) typography.headingApproxScale = "large";
          else if (scale >= 1.5) typography.headingApproxScale = "medium";
          else if (scale > 0) typography.headingApproxScale = "small";
        }

        const sampleNodes = queryVisible(
          document.body,
          "a[href], button, [role='button'], input, section, article, div, img",
          50,
          () => true
        );

        let borderRadiusValue = "";
        let hasShadows = false;

        sampleNodes.forEach((node) => {
          const style = getStyle(node);
          if (!style) return;
          if (!borderRadiusValue) {
            const radius = toNumber(style.borderTopLeftRadius || style.borderRadius);
            if (radius > 0) borderRadiusValue = roundToStep(radius, 2);
          }
          if (!hasShadows && style.boxShadow && style.boxShadow !== "none") {
            hasShadows = true;
          }
        });

        if (borderRadiusValue) shape.borderRadius = borderRadiusValue;
        shape.hasShadows = hasShadows;

        const visualTokens = {};
        if (Object.keys(colors).length) visualTokens.colors = colors;
        if (Object.keys(typography).length) visualTokens.typography = typography;
        if (Object.keys(shape).length) visualTokens.shape = shape;
        return visualTokens;
      }

      function collectAssets(sectionNodes, pageStructure) {
        const images = Array.from(document.images || []).filter((image) => isElementVisible(image));
        const resolvedSectionIds = new Set(pageStructure.map((item) => item.id));
        const assets = {
          logo: null,
          heroImages: [],
          categoryImages: [],
          promoImages: [],
          icons: []
        };

        function pushUnique(target, value, limit) {
          if (!value || target.includes(value) || target.length >= limit) return;
          target.push(value);
        }

        function getImageSource(image) {
          return normalizeText(image.currentSrc || image.src || image.getAttribute("src") || "", 500);
        }

        let logoNode = images.find((image) => {
          const headerParent = image.closest("header, nav");
          return headerParent && isElementVisible(headerParent);
        });

        if (!logoNode) {
          logoNode = images.find((image) => /logo/i.test(String(image.alt || "")));
        }

        if (!logoNode) {
          logoNode = images.find((image) => {
            const rect = getRect(image);
            return rect.top <= viewport.height && rect.left <= viewport.width * 0.35;
          });
        }

        if (logoNode) {
          assets.logo = getImageSource(logoNode) || null;
        }

        const heroSectionIds = new Set(
          pageStructure
            .filter((item) => item && /^(hero|hero-split)$/i.test(item.type || "") && resolvedSectionIds.has(item.id))
            .map((item) => item.id)
        );
        const categorySectionIds = new Set(
          pageStructure
            .filter((item) => item && /^(category-strip|product-grid|product-carousel)$/i.test(item.type || "") && resolvedSectionIds.has(item.id))
            .map((item) => item.id)
        );
        const promoSectionIds = new Set(
          pageStructure
            .filter((item) => item && /^(promo-banner|multi-column-cta)$/i.test(item.type || "") && resolvedSectionIds.has(item.id))
            .map((item) => item.id)
        );

        sectionNodes.forEach((node, index) => {
          if (assets.heroImages.length >= 3 && assets.categoryImages.length >= 3 && assets.promoImages.length >= 2) return;
          const sectionId = `section-${index + 1}`;
          const imagesInSection = queryVisible(node, "img", 6, () => true);
          imagesInSection.forEach((image) => {
            const rect = getRect(image);
            const source = getImageSource(image);
            if (!source || source === assets.logo) return;
            if (heroSectionIds.has(sectionId) && (rect.height >= 220 || rect.width >= viewport.width * 0.3)) {
              pushUnique(assets.heroImages, source, 3);
              return;
            }
            if (categorySectionIds.has(sectionId) && (rect.height >= 80 || rect.width >= 80)) {
              pushUnique(assets.categoryImages, source, 3);
              return;
            }
            if (promoSectionIds.has(sectionId) && (rect.height >= 140 || rect.width >= viewport.width * 0.28)) {
              pushUnique(assets.promoImages, source, 2);
              return;
            }
            if (rect.height >= 300 || rect.width >= viewport.width * 0.35) {
              pushUnique(assets.heroImages, source, 3);
            }
          });
        });

        images.forEach((image) => {
          if (assets.icons.length >= 6) return;
          const source = getImageSource(image);
          const rect = getRect(image);
          if (!source || source === assets.logo || assets.heroImages.includes(source)) return;
          if (rect.width <= 64 && rect.height <= 64) {
            pushUnique(assets.icons, source, 6);
          }
        });

        let remainingAssetRefs = MAX_ASSET_REFS - [assets.logo].filter(Boolean).length;
        ["heroImages", "categoryImages", "promoImages", "icons"].forEach((key) => {
          if (remainingAssetRefs <= 0) {
            assets[key] = [];
            return;
          }
          if (assets[key].length > remainingAssetRefs) {
            assets[key] = assets[key].slice(0, remainingAssetRefs);
          }
          remainingAssetRefs -= assets[key].length;
        });

        const totalAssetRefs = [assets.logo].filter(Boolean).length +
          assets.heroImages.length +
          assets.categoryImages.length +
          assets.promoImages.length +
          assets.icons.length;
        if (totalAssetRefs > MAX_ASSET_REFS) {
          assets.icons = assets.icons.slice(0, Math.max(0, MAX_ASSET_REFS - (
            [assets.logo].filter(Boolean).length +
            assets.heroImages.length +
            assets.categoryImages.length +
            assets.promoImages.length
          )));
        }

        return assets;
      }

      function collectLayoutHints(sectionNodes, pageStructure) {
        if (!sectionNodes.length) return {};

        const widths = sectionNodes
          .map((node) => getRect(node).width)
          .filter((width) => Number.isFinite(width) && width >= 320 && width < viewport.width * 0.96);
        const maxWidth = widths.length ? roundToStep(Math.max.apply(null, widths), 20) : "";

        const centeredCount = pageStructure.filter((item) => item && item.isCentered).length;
        const hasCenteredLayout = centeredCount >= Math.max(1, Math.ceil(pageStructure.length / 2));

        const gaps = [];
        for (let index = 1; index < sectionNodes.length; index += 1) {
          const prevRect = getRect(sectionNodes[index - 1]);
          const nextRect = getRect(sectionNodes[index]);
          const gap = Math.max(0, nextRect.top - prevRect.bottom);
          gaps.push(gap);
        }

        const averageGap = gaps.length
          ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length
          : 0;
        let sectionSpacing = "medium";
        if (averageGap > 96) sectionSpacing = "large";
        else if (averageGap > 0 && averageGap < 28) sectionSpacing = "tight";

        const headerSection = pageStructure.find((item) => item && item.type === "header");
        let headerStyle = "";
        if (headerSection) {
          const headerNode = sectionNodes[pageStructure.indexOf(headerSection)];
          const linkCount = headerNode ? countVisibleLinks(headerNode) : 0;
          const hasLogo = Boolean(headerNode && queryVisible(headerNode, "img", 2, () => true).length);
          if (hasLogo && linkCount >= 3) headerStyle = "logo-left-nav-right";
          else if (linkCount >= 3) headerStyle = "top-nav";
          else headerStyle = "minimal";
        }

        const averageTextLength = pageStructure.length
          ? pageStructure.reduce((sum, item) => {
            if (!item || !item.textDensity) return sum;
            if (item.textDensity === "high") return sum + 3;
            if (item.textDensity === "medium") return sum + 2;
            return sum + 1;
          }, 0) / pageStructure.length
          : 0;
        let contentDensity = "medium";
        if (averageTextLength >= 2.4) contentDensity = "high";
        else if (averageTextLength <= 1.4) contentDensity = "low";

        const topBandCount = pageStructure.filter((item) => item && /^(announcement-bar|utility-nav|primary-nav|header)$/i.test(item.type || "")).length;
        const heroSection = pageStructure.find((item) => item && /^(hero|hero-split)$/i.test(item.type || ""));
        const heroNode = heroSection ? sectionNodes[pageStructure.indexOf(heroSection)] : null;
        const heroRect = heroNode ? getRect(heroNode) : null;
        let heroDominance = "low";
        if (heroRect && heroRect.height >= viewport.height * 0.55) heroDominance = "high";
        else if (heroRect && heroRect.height >= viewport.height * 0.32) heroDominance = "medium";

        let sectionDensity = "medium";
        if (pageStructure.length >= 8 || contentDensity === "high") sectionDensity = "high";
        else if (pageStructure.length <= 4 && contentDensity === "low") sectionDensity = "low";

        let visualHierarchy = "simple";
        if (topBandCount >= 2 || pageStructure.length >= 8) visualHierarchy = "dense";
        else if (pageStructure.length >= 5 || new Set(pageStructure.map((item) => item.type)).size >= 4) visualHierarchy = "layered";

        const layoutHints = {
          hasCenteredLayout,
          sectionSpacing,
          contentDensity,
          heroDominance,
          topBandCount,
          sectionDensity,
          visualHierarchy
        };
        if (maxWidth) layoutHints.maxWidth = maxWidth;
        if (headerStyle) layoutHints.headerStyle = headerStyle;
        return layoutHints;
      }

      function collectPageSignals(pageStructure, layoutHints) {
        const typeSet = new Set(pageStructure.map((item) => item && item.type).filter(Boolean));
        if (!typeSet.size) return {};

        const pageSignals = {
          hasAnnouncementBar: typeSet.has("announcement-bar"),
          hasUtilityNav: typeSet.has("utility-nav"),
          hasPrimaryNav: typeSet.has("primary-nav") || typeSet.has("header"),
          hasCategoryStrip: typeSet.has("category-strip"),
          hasProductModules: typeSet.has("product-grid") || typeSet.has("product-carousel"),
          hasPromoBanners: typeSet.has("promo-banner") || typeSet.has("multi-column-cta"),
          hasEditorialGrid: typeSet.has("editorial-grid")
        };

        pageSignals.isCommerceDense = (
          (pageSignals.hasPrimaryNav && pageSignals.hasCategoryStrip && pageSignals.hasProductModules) ||
          Object.values(pageSignals).filter(Boolean).length >= 4 ||
          String(layoutHints && layoutHints.visualHierarchy ? layoutHints.visualHierarchy : "") === "dense"
        );

        return Object.values(pageSignals).some(Boolean) ? pageSignals : {};
      }

      function collectDesignSystem(sectionNodes, pageStructure, layoutHints, pageSignals, visualTokens) {
        try {
          if (!document.body || !sectionNodes.length || !pageStructure.length) return {};

          const typeSet = new Set(pageStructure.map((item) => item && item.type).filter(Boolean));
          const bodyStyle = getStyle(document.body);
          const rootStyle = getStyle(document.documentElement);
          const pageBackgroundColor = normalizeColor(
            (bodyStyle && bodyStyle.backgroundColor) ||
            (rootStyle && rootStyle.backgroundColor) ||
            ""
          );
          const textColor = normalizeColor(
            (bodyStyle && bodyStyle.color) ||
            (visualTokens && visualTokens.colors && visualTokens.colors.text) ||
            ""
          );

          const backgroundCandidates = new Map();
          const surfaceCandidates = new Map();
          const accentCandidates = new Map();
          const textCandidates = new Map();
          const mutedTextCandidates = new Map();
          const borderCandidates = new Map();

          addColorWeight(backgroundCandidates, visualTokens && visualTokens.colors && visualTokens.colors.background, 5);
          addColorWeight(backgroundCandidates, pageBackgroundColor, 4);
          addColorWeight(textCandidates, textColor, 5);
          addColorWeight(accentCandidates, visualTokens && visualTokens.colors && visualTokens.colors.accent, 4);

          sectionNodes.slice(0, 8).forEach((node, index) => {
            const style = getStyle(node);
            const rect = getRect(node);
            if (!style || rect.width < 120 || rect.height < 60) return;
            const backgroundColor = normalizeColor(style.backgroundColor);
            if (backgroundColor) {
              if (index === 0 || rect.width >= viewport.width * 0.82) {
                addColorWeight(backgroundCandidates, backgroundColor, index === 0 ? 4 : 2);
              } else {
                addColorWeight(surfaceCandidates, backgroundColor, 2);
              }
            }
            const borderWidth = Math.max(
              toNumber(style.borderTopWidth),
              toNumber(style.borderLeftWidth),
              toNumber(style.borderWidth)
            );
            if (borderWidth > 0) {
              addColorWeight(borderCandidates, style.borderColor, 2);
            }
          });

          const headingNodes = queryVisible(document.body, "h1, h2, h3", 6, (match) => normalizeText(match.innerText || "", 120));
          const bodyTextNodes = queryVisible(
            document.body,
            "p, li, small, label, span",
            18,
            (match) => normalizeText(match.innerText || "", 120)
          );
          const interactiveNodes = queryVisible(
            document.body,
            "a[href], button, [role='button'], input[type='button'], input[type='submit']",
            16,
            (match) => {
              const text = normalizeText(
                match.innerText || match.value || match.getAttribute("aria-label") || "",
                80
              );
              return Boolean(text);
            }
          );

          headingNodes.forEach((node, index) => {
            const style = getStyle(node);
            if (!style) return;
            addColorWeight(textCandidates, style.color, index === 0 ? 3 : 1);
          });

          bodyTextNodes.forEach((node, index) => {
            const style = getStyle(node);
            if (!style) return;
            const nodeColor = normalizeColor(style.color);
            if (!nodeColor) return;
            if (textColor && nodeColor !== textColor) {
              addColorWeight(mutedTextCandidates, nodeColor, index < 6 ? 2 : 1);
              return;
            }
            addColorWeight(textCandidates, nodeColor, 1);
          });

          const buttonStyleCounts = { solid: 0, outline: 0, text: 0 };
          const radiusSamples = [];
          let sawRadiusSample = false;

          interactiveNodes.forEach((node) => {
            const style = getStyle(node);
            const rect = getRect(node);
            if (!style || rect.width < 32 || rect.height < 20) return;

            const className = normalizeText([
              node.className || "",
              node.id || "",
              node.getAttribute("role") || ""
            ].join(" "), 120).toLowerCase();
            const borderWidth = Math.max(
              toNumber(style.borderTopWidth),
              toNumber(style.borderLeftWidth),
              toNumber(style.borderWidth)
            );
            const paddingX = toNumber(style.paddingLeft) + toNumber(style.paddingRight);
            const backgroundColor = normalizeColor(style.backgroundColor);
            const foregroundColor = normalizeColor(style.color);
            const isButtonLike = /(\bbtn\b|button|cta)/.test(className) ||
              /^(button|input)$/i.test(node.tagName || "") ||
              String(node.getAttribute("role") || "").toLowerCase() === "button" ||
              borderWidth > 0 ||
              !isTransparentColor(style.backgroundColor) ||
              (rect.height >= 30 && paddingX >= 20);

            if (!isButtonLike) {
              if (foregroundColor && foregroundColor !== textColor) {
                addColorWeight(accentCandidates, foregroundColor, 1);
              }
              return;
            }

            const radius = toNumber(style.borderTopLeftRadius || style.borderRadius);
            sawRadiusSample = true;
            radiusSamples.push(radius);

            if (backgroundColor && backgroundColor !== pageBackgroundColor && backgroundColor !== textColor) {
              addColorWeight(accentCandidates, backgroundColor, 3);
              buttonStyleCounts.solid += 1;
            } else if (borderWidth > 0 && !isTransparentColor(style.borderColor)) {
              addColorWeight(borderCandidates, style.borderColor, 2);
              if (foregroundColor && foregroundColor !== textColor) {
                addColorWeight(accentCandidates, foregroundColor, 2);
              }
              buttonStyleCounts.outline += 1;
            } else {
              if (foregroundColor && foregroundColor !== textColor) {
                addColorWeight(accentCandidates, foregroundColor, 1);
              }
              buttonStyleCounts.text += 1;
            }
          });

          const cardCandidates = [];
          pageStructure.forEach((item, index) => {
            if (cardCandidates.length >= 10) return;
            if (!item || !/^(grid|product-grid|product-carousel|editorial-grid|feature-icons|multi-column-cta|category-strip)$/i.test(item.type || "")) {
              return;
            }
            const node = sectionNodes[index];
            const children = getDirectVisibleChildren(unwrapDominantChild(node), 6).filter((child) => {
              const rect = getRect(child);
              return rect.width >= 96 && rect.height >= 72;
            });
            children.forEach((child) => {
              if (cardCandidates.length < 10) cardCandidates.push(child);
            });
          });

          const cardStyleCounts = { flat: 0, outlined: 0, elevated: 0 };
          cardCandidates.forEach((node) => {
            const style = getStyle(node);
            if (!style) return;
            const backgroundColor = normalizeColor(style.backgroundColor);
            const borderWidth = Math.max(
              toNumber(style.borderTopWidth),
              toNumber(style.borderLeftWidth),
              toNumber(style.borderWidth)
            );
            const radius = toNumber(style.borderTopLeftRadius || style.borderRadius);
            sawRadiusSample = true;
            radiusSamples.push(radius);

            if (style.boxShadow && style.boxShadow !== "none") {
              cardStyleCounts.elevated += 1;
              return;
            }
            if (borderWidth > 0 && !isTransparentColor(style.borderColor)) {
              addColorWeight(borderCandidates, style.borderColor, 1);
              cardStyleCounts.outlined += 1;
              return;
            }
            if (backgroundColor && backgroundColor !== pageBackgroundColor) {
              addColorWeight(surfaceCandidates, backgroundColor, 2);
              cardStyleCounts.flat += 1;
            }
          });

          const colorRoles = {};
          const backgroundRanked = pickRankedColors(backgroundCandidates);
          const surfaceRanked = pickRankedColors(surfaceCandidates);
          const accentRanked = pickRankedColors(accentCandidates);
          const textRanked = pickRankedColors(textCandidates);
          const mutedRanked = pickRankedColors(mutedTextCandidates);
          const borderRanked = pickRankedColors(borderCandidates);

          const backgroundRole = backgroundRanked[0] || pageBackgroundColor;
          const textRole = textRanked[0] || textColor;
          const primaryRole = accentRanked[0] || textRole;
          const secondaryRole = accentRanked.find((color) => color && color !== primaryRole) || "";
          const surfaceRole = surfaceRanked.find((color) => color && color !== backgroundRole) || "";
          const mutedTextRole = mutedRanked.find((color) => color && color !== textRole) || "";
          const borderRole = borderRanked.find((color) => color && color !== backgroundRole) || "";

          if (primaryRole) colorRoles.primary = primaryRole;
          if (secondaryRole) colorRoles.secondary = secondaryRole;
          if (backgroundRole) colorRoles.background = backgroundRole;
          if (surfaceRole) colorRoles.surface = surfaceRole;
          if (textRole) colorRoles.text = textRole;
          if (mutedTextRole) colorRoles.mutedText = mutedTextRole;
          if (borderRole) colorRoles.border = borderRole;

          const typographySystem = {};
          const headingNode = headingNodes[0] || null;
          const headingStyle = headingNode ? getStyle(headingNode) : null;
          const bodyTextNode = bodyTextNodes[0] || null;
          const bodyTextStyle = bodyTextNode ? getStyle(bodyTextNode) : null;
          const bodyFontFamily = normalizeFontFamily(
            (bodyTextStyle && bodyTextStyle.fontFamily) ||
            (bodyStyle && bodyStyle.fontFamily) ||
            (rootStyle && rootStyle.fontFamily) ||
            ""
          );
          const headingFontFamily = normalizeFontFamily(
            (headingStyle && headingStyle.fontFamily) ||
            bodyFontFamily
          );
          const baseFontSize = (bodyTextStyle && bodyTextStyle.fontSize) || (bodyStyle && bodyStyle.fontSize) || "";
          const headingFontSize = headingStyle ? toNumber(headingStyle.fontSize) : 0;
          const baseFontSizeValue = toNumber(baseFontSize);
          const headingScale = baseFontSizeValue > 0 ? headingFontSize / baseFontSizeValue : 0;

          if (headingFontFamily) typographySystem.headingFontFamily = headingFontFamily;
          if (bodyFontFamily) typographySystem.bodyFontFamily = bodyFontFamily;
          if (headingStyle) typographySystem.headingStyle = classifyFontStyle(headingStyle.fontWeight);
          if (bodyTextStyle || bodyStyle) {
            typographySystem.bodyStyle = classifyFontStyle(
              (bodyTextStyle && bodyTextStyle.fontWeight) ||
              (bodyStyle && bodyStyle.fontWeight) ||
              ""
            );
          }
          if (baseFontSize) typographySystem.baseFontSize = baseFontSize;
          if (headingScale >= 2.1) typographySystem.headingScale = "large";
          else if (headingScale >= 1.45) typographySystem.headingScale = "medium";
          else if (headingScale > 0) typographySystem.headingScale = "small";

          const spacingSystem = {};
          const fullWidthCount = pageStructure.filter((item) => item && item.isFullWidth).length;
          const maxWidthValue = toNumber(layoutHints && layoutHints.maxWidth ? layoutHints.maxWidth : "");
          let containerWidth = "";
          if (fullWidthCount >= Math.max(2, Math.ceil(pageStructure.length / 2))) containerWidth = "full";
          else if (maxWidthValue >= 1220) containerWidth = "wide";
          else if (maxWidthValue >= 960) containerWidth = "medium";
          else if (maxWidthValue > 0) containerWidth = "narrow";

          if (layoutHints && layoutHints.sectionSpacing) {
            spacingSystem.sectionSpacing = layoutHints.sectionSpacing === "large"
              ? "spacious"
              : layoutHints.sectionSpacing;
          }
          if (containerWidth) spacingSystem.containerWidth = containerWidth;
          if (layoutHints && layoutHints.contentDensity) spacingSystem.contentDensity = layoutHints.contentDensity;

          const shapeSystem = {};
          if (sawRadiusSample) {
            const averageRadius = radiusSamples.length
              ? radiusSamples.reduce((sum, value) => sum + value, 0) / radiusSamples.length
              : 0;
            shapeSystem.borderRadius = classifyRadius(averageRadius);
          }

          const buttonStyleEntries = Object.entries(buttonStyleCounts).filter((entry) => entry[1] > 0);
          if (buttonStyleEntries.length) {
            buttonStyleEntries.sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1]);
            const buttonTotal = buttonStyleEntries.reduce((sum, entry) => sum + entry[1], 0);
            shapeSystem.buttonStyle = buttonStyleEntries[0][1] >= Math.max(2, Math.ceil(buttonTotal * 0.6))
              ? buttonStyleEntries[0][0]
              : "mixed";
          }

          const cardStyleEntries = Object.entries(cardStyleCounts).filter((entry) => entry[1] > 0);
          if (cardStyleEntries.length) {
            cardStyleEntries.sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1]);
            const cardTotal = cardStyleEntries.reduce((sum, entry) => sum + entry[1], 0);
            shapeSystem.cardStyle = cardStyleEntries[0][1] >= Math.max(2, Math.ceil(cardTotal * 0.6))
              ? cardStyleEntries[0][0]
              : "mixed";
          }

          const layoutPatterns = {};
          const topBandCount = pageStructure.filter((item) => item && /^(announcement-bar|utility-nav|primary-nav|header)$/i.test(item.type || "")).length;
          const headerSection = pageStructure.find((item) => item && /^(announcement-bar|utility-nav|primary-nav|header)$/i.test(item.type || ""));
          const heroSection = pageStructure.find((item) => item && /^(hero|hero-split)$/i.test(item.type || ""));
          const contentSections = pageStructure.filter((item) => item && !/^(announcement-bar|utility-nav|primary-nav|header|footer)$/i.test(item.type || ""));
          const nonStackedCount = contentSections.filter((item) => item && item.approxColumns >= 2).length;
          const gridCounts = { 2: 0, 3: 0, 4: 0 };

          contentSections.forEach((item) => {
            const columns = Number(item && item.approxColumns ? item.approxColumns : 0);
            if (columns >= 2 && columns <= 4) {
              gridCounts[columns] += 1;
            }
          });

          if (topBandCount >= 2) layoutPatterns.headerPattern = "multi-band";
          else if (headerSection) {
            layoutPatterns.headerPattern = (
              (layoutHints && layoutHints.headerStyle === "minimal") ||
              (headerSection.approxColumns <= 1 && !pageSignals.hasPrimaryNav)
            )
              ? "minimal"
              : "single-band";
          }

          if (heroSection) {
            if (heroSection.type === "hero-split" || heroSection.approxColumns >= 2) layoutPatterns.heroPattern = "split";
            else if (!heroSection.hasImage) layoutPatterns.heroPattern = "text-only";
            else if (heroSection.textDensity === "high") layoutPatterns.heroPattern = "editorial";
            else layoutPatterns.heroPattern = "image-dominant";
          } else if (contentSections[0] && contentSections[0].type === "editorial-grid") {
            layoutPatterns.heroPattern = "editorial";
          }

          if (contentSections.length) {
            if (!nonStackedCount) layoutPatterns.sectionRhythm = "stacked";
            else {
              let transitions = 0;
              for (let index = 1; index < contentSections.length; index += 1) {
                const previousMode = contentSections[index - 1].approxColumns >= 2 ? "multi" : "stacked";
                const currentMode = contentSections[index].approxColumns >= 2 ? "multi" : "stacked";
                if (previousMode !== currentMode) transitions += 1;
              }
              layoutPatterns.sectionRhythm = transitions >= Math.max(1, Math.floor(contentSections.length / 3))
                ? "alternating"
                : "mixed";
            }
          }

          const rankedGridPatterns = Object.entries(gridCounts)
            .filter((entry) => entry[1] > 0)
            .sort((leftEntry, rightEntry) => rightEntry[1] - leftEntry[1]);
          if (rankedGridPatterns.length === 1) {
            layoutPatterns.gridPattern = `${rankedGridPatterns[0][0]}-column`;
          } else if (rankedGridPatterns.length >= 2) {
            layoutPatterns.gridPattern = rankedGridPatterns[0][1] > rankedGridPatterns[1][1]
              ? `${rankedGridPatterns[0][0]}-column`
              : "mixed";
          }

          const componentHints = {};
          if (pageSignals.hasAnnouncementBar) componentHints.hasTopAnnouncementBar = true;
          if (pageSignals.hasUtilityNav) componentHints.hasUtilityNav = true;
          if (pageSignals.hasPrimaryNav) componentHints.hasPrimaryNav = true;
          if (typeSet.has("category-strip")) componentHints.hasCategoryTiles = true;
          if (typeSet.has("promo-banner") || typeSet.has("multi-column-cta")) componentHints.hasPromoModules = true;
          if (typeSet.has("editorial-grid")) componentHints.hasEditorialGrid = true;
          if (typeSet.has("feature-icons")) componentHints.hasFeatureIcons = true;

          const newsletterMatch = queryVisible(
            document.body,
            "section, article, aside, footer, form, div",
            24,
            (match) => {
              const text = normalizeText(match.innerText || "", 220).toLowerCase();
              const hasEmailInput = Boolean(match.querySelector(
                "input[type='email'], input[name*='email' i], input[placeholder*='email' i]"
              ));
              return hasEmailInput && /\b(newsletter|subscribe|sign up|join our list|get updates|stay in touch)\b/.test(text);
            }
          );
          if (newsletterMatch.length) componentHints.hasNewsletterBlock = true;

          const designSystem = {};
          if (Object.keys(colorRoles).length) designSystem.colorRoles = colorRoles;
          if (Object.keys(typographySystem).length) designSystem.typographySystem = typographySystem;
          if (Object.keys(spacingSystem).length) designSystem.spacingSystem = spacingSystem;
          if (Object.keys(shapeSystem).length) designSystem.shapeSystem = shapeSystem;
          if (Object.keys(layoutPatterns).length) designSystem.layoutPatterns = layoutPatterns;
          if (Object.keys(componentHints).length) designSystem.componentHints = componentHints;
          return designSystem;
        } catch (_error) {
          return {};
        }
      }

      const sectionNodes = collectSectionCandidates();
      if (!sectionNodes.length) return {};

      const pageStructure = [];
      const sectionContent = {};

      sectionNodes.forEach((node, index) => {
        if (pageStructure.length >= MAX_SECTIONS) return;
        const rect = getRect(node);
        const approxColumns = inferColumns(node);
        const repeatedBlocks = inferRepeatedBlocks(node);
        const heading = findFirstText(node, "h1, h2, h3", 6);
        const ctaText = findFirstCta(node);
        const textDensity = inferTextDensity(node);
        const linkCount = countVisibleLinks(node);
        const sectionInfo = {
          rect,
          heading,
          ctaText,
          hasCTA: Boolean(ctaText),
          repeatedBlocks,
          approxColumns,
          approxLayout: inferLayoutLabel(approxColumns, repeatedBlocks),
          textDensity,
          linkCount
        };
        const sectionSignals = buildSectionSignals(node, sectionInfo);
        const hasImage = sectionSignals.imageCount > 0;
        sectionInfo.hasImage = hasImage;
        const entry = {
          id: `section-${index + 1}`,
          type: classifySection(node, index, sectionNodes.length, sectionInfo, sectionSignals),
          order: index + 1,
          hasImage,
          hasCTA: Boolean(ctaText),
          textDensity,
          approxLayout: sectionInfo.approxLayout,
          approxColumns,
          isFullWidth: rect.width >= viewport.width * 0.82,
          isCentered: inferCentered(node)
        };
        pageStructure.push(entry);

        const contentEntry = collectSectionContent(node, entry.id, entry.type, sectionInfo, sectionSignals);
        if (contentEntry) {
          Object.assign(sectionContent, contentEntry);
        }
      });

      const structuredData = {};
      if (pageStructure.length) structuredData.pageStructure = pageStructure;
      if (Object.keys(sectionContent).length) structuredData.sectionContent = sectionContent;

      const visualTokens = collectVisualTokens(sectionNodes);
      if (Object.keys(visualTokens).length) structuredData.visualTokens = visualTokens;

      const assets = collectAssets(sectionNodes, pageStructure);
      if (assets.logo || assets.heroImages.length || assets.categoryImages.length || assets.promoImages.length || assets.icons.length) {
        structuredData.assets = assets;
      }

      const layoutHints = collectLayoutHints(sectionNodes, pageStructure);
      if (Object.keys(layoutHints).length) structuredData.layoutHints = layoutHints;

      const pageSignals = collectPageSignals(pageStructure, layoutHints);
      if (Object.keys(pageSignals).length) structuredData.pageSignals = pageSignals;

      const designSystem = collectDesignSystem(sectionNodes, pageStructure, layoutHints, pageSignals, visualTokens);
      if (Object.keys(designSystem).length) structuredData.designSystem = designSystem;

      return structuredData;
    }, VIEWPORT);
  } catch (error) {
    console.warn("SITE_SCAN_STRUCTURED_DATA_WARN", error && error.message ? error.message : error);
    return {};
  }
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
    const structuredData = await extractStructuredData(page);
    console.log("SITE_SCAN_STRUCTURED_DATA_OK");
    const previewImageUrl = await buildScanPreviewDataUrl(page);
    console.log("SITE_SCAN_SCREENSHOT_OK");

    const discoveredPages = await discoverSitePages(browser, rootUrl, metadata);
    const detectedPages = Math.max(1, discoveredPages.length);
    const persistedStructuredData = structuredData && typeof structuredData === "object"
      ? structuredData
      : {};
    const hasStructuredData = Object.keys(persistedStructuredData).length > 0;

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
        predictedSections: Array.isArray(item.predictedSections) ? item.predictedSections : [],
        ...(index === 0 && hasStructuredData ? { structuredData: persistedStructuredData } : {})
      })),
      scanStatus: "completed",
      structuredData: persistedStructuredData
    };
    if (hasStructuredData) {
      console.log("SITE_SCAN_STRUCTURED_DATA_PERSIST_READY");
    }
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
