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
        const minimumHeight = /^(header|nav)$/i.test(tagName) ? 72 : 120;
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

        return output.slice(0, MAX_SECTIONS);
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

      function classifySection(node, index, total, sectionInfo) {
        const tag = String(node.tagName || "").toLowerCase();
        const clueText = normalizeText([
          node.id || "",
          typeof node.className === "string" ? node.className : "",
          node.getAttribute("role") || "",
          node.getAttribute("aria-label") || ""
        ].join(" "), 200).toLowerCase();
        const linkCount = countVisibleLinks(node);

        if (
          tag === "header" ||
          tag === "nav" ||
          /\b(header|nav|menu)\b/.test(clueText) ||
          (index === 0 && linkCount >= 3 && sectionInfo.rect.top < viewport.height * 0.4)
        ) {
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
          index <= 1 &&
          sectionInfo.heading &&
          sectionInfo.rect.height >= 220 &&
          (sectionInfo.hasCTA || sectionInfo.hasImage)
        ) {
          return "hero";
        }

        if (sectionInfo.approxLayout === "grid" || (sectionInfo.approxColumns >= 2 && sectionInfo.repeatedBlocks >= 3)) {
          return "grid";
        }

        return "section";
      }

      function collectSectionContent(node, sectionId) {
        const heading = findFirstText(node, "h1, h2, h3", 6);
        const subheading = findFirstText(node, "p, h4, h5, h6", 8);
        const cta = findFirstCta(node);
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
            .filter((item) => item && item.type === "hero" && resolvedSectionIds.has(item.id))
            .map((item) => item.id)
        );

        sectionNodes.forEach((node, index) => {
          if (assets.heroImages.length >= 3) return;
          const sectionId = `section-${index + 1}`;
          const imagesInSection = queryVisible(node, "img", 6, () => true);
          imagesInSection.forEach((image) => {
            if (assets.heroImages.length >= 3) return;
            const rect = getRect(image);
            const source = getImageSource(image);
            if (!source || source === assets.logo) return;
            if (!heroSectionIds.has(sectionId) && rect.height < 300) return;
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

        const totalAssetRefs = [assets.logo].filter(Boolean).length + assets.heroImages.length + assets.icons.length;
        if (totalAssetRefs > MAX_ASSET_REFS) {
          assets.icons = assets.icons.slice(0, Math.max(0, MAX_ASSET_REFS - [assets.logo].filter(Boolean).length - assets.heroImages.length));
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

        const layoutHints = {
          hasCenteredLayout,
          sectionSpacing,
          contentDensity
        };
        if (maxWidth) layoutHints.maxWidth = maxWidth;
        if (headerStyle) layoutHints.headerStyle = headerStyle;
        return layoutHints;
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
        const cta = findFirstCta(node);
        const hasImage = Boolean(queryVisible(node, "img", 1, () => true).length);
        const sectionInfo = {
          rect,
          heading,
          hasCTA: Boolean(cta),
          hasImage,
          repeatedBlocks,
          approxColumns,
          approxLayout: inferLayoutLabel(approxColumns, repeatedBlocks)
        };
        const entry = {
          id: `section-${index + 1}`,
          type: classifySection(node, index, sectionNodes.length, sectionInfo),
          order: index + 1,
          hasImage,
          hasCTA: Boolean(cta),
          textDensity: inferTextDensity(node),
          approxLayout: sectionInfo.approxLayout,
          approxColumns,
          isFullWidth: rect.width >= viewport.width * 0.82,
          isCentered: inferCentered(node)
        };
        pageStructure.push(entry);

        const contentEntry = collectSectionContent(node, entry.id);
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
      if (assets.logo || assets.heroImages.length || assets.icons.length) {
        structuredData.assets = assets;
      }

      const layoutHints = collectLayoutHints(sectionNodes, pageStructure);
      if (Object.keys(layoutHints).length) structuredData.layoutHints = layoutHints;

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
