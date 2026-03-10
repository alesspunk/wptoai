(function () {
  var LEGACY_KEYS_TO_CLEAR = [
    "wptoai.quickQuoteState.v1",
    "wptoai.checkoutEmail.v1",
    "wptoai.quoteDraft.v1",
    "wptoai.heroPreviewState.v1",
    "wptoai.heroPreviewJourneyState.v1",
    "wptoai.previewState"
  ];

  var state = {
    projectId: "",
    token: "",
    project: null,
    pages: [],
    selectedId: "",
    collapsedSections: {},
    contextTargetId: "",
    timers: {},
    now: Date.now()
  };

  var refs = {
    domain: document.querySelector("#project-domain"),
    progressFill: document.querySelector("#project-progress-fill"),
    progressCopy: document.querySelector("#project-progress-copy"),
    detectedPages: document.querySelector("#detected-pages"),
    purchasedPages: document.querySelector("#purchased-pages"),
    usedPages: document.querySelector("#used-pages"),
    remainingPages: document.querySelector("#remaining-pages"),
    addPageBtn: document.querySelector("#add-page-btn"),
    tree: document.querySelector("#page-tree"),
    treeStatus: document.querySelector("#tree-status"),
    selectedTitle: document.querySelector("#selected-title"),
    selectedStatusPill: document.querySelector("#selected-status-pill"),
    selectedUrlPill: document.querySelector("#selected-url-pill"),
    selectedPagesPill: document.querySelector("#selected-pages-pill"),
    viewerContent: document.querySelector("#viewer-content"),
    contextMenu: document.querySelector("#page-context-menu"),
    updatePasswordBtn: document.querySelector("#update-password-btn"),
    passwordStatus: document.querySelector("#password-status")
  };

  function clearLegacyQuoteState() {
    try {
      if (!window.sessionStorage) return;
      LEGACY_KEYS_TO_CLEAR.forEach(function (key) {
        window.sessionStorage.removeItem(key);
      });
    } catch (_error) {
      // ignore
    }
  }

  function parseAccessFromUrl() {
    var params = new URLSearchParams(window.location.search || "");
    return {
      project: String(params.get("project") || "").trim(),
      token: String(params.get("token") || "").trim()
    };
  }

  function setFatalMessage(message) {
    document.body.innerHTML =
      '<div style="padding:32px;font-family:Inter,Arial,sans-serif;color:#27314d;">' +
      String(message || "Session expired. Please check your email for your project access link.") +
      "</div>";
  }

  function normalizePage(page, index) {
    var safe = page && typeof page === "object" ? page : {};
    return {
      id: String(safe.id || ("page_" + index)),
      title: String(safe.title || "Untitled"),
      url: String(safe.url || ""),
      type: String(safe.type || "page"),
      parentId: safe.parentId ? String(safe.parentId) : null,
      status: String(safe.status || "queued"),
      screenshotUrl: String(safe.screenshotUrl || ""),
      orderIndex: Number.isFinite(Number(safe.orderIndex)) ? Number(safe.orderIndex) : index,
      justReadyUntil: 0
    };
  }

  function getById(id) {
    for (var i = 0; i < state.pages.length; i += 1) {
      if (state.pages[i].id === id) return state.pages[i];
    }
    return null;
  }

  function getChildren(parentId) {
    var normalizedParentId = parentId ? String(parentId) : null;
    return state.pages
      .filter(function (page) {
        return (page.parentId || null) === normalizedParentId;
      })
      .sort(function (a, b) {
        if (a.orderIndex === b.orderIndex) return a.title.localeCompare(b.title);
        return a.orderIndex - b.orderIndex;
      });
  }

  function getUsage() {
    var used = state.pages.filter(function (page) {
      return page.type === "homepage" || page.type === "page";
    }).length;
    var purchased = Number(state.project && state.project.purchasedPages ? state.project.purchasedPages : 0);
    var remaining = Math.max(0, purchased - used);
    return { used: used, purchased: purchased, remaining: remaining };
  }

  function inferProgress() {
    var usage = getUsage();
    var total = Math.max(usage.used, 1);
    var readyCount = state.pages.filter(function (page) {
      return (page.type === "homepage" || page.type === "page") && page.status === "ready";
    }).length;
    var computed = Math.round((readyCount / total) * 100);
    var seeded = Number(state.project && state.project.migrationProgress ? state.project.migrationProgress : 0);
    var value = Math.max(computed, seeded);
    return Math.max(0, Math.min(100, value));
  }

  function showTreeStatus(message, isError) {
    if (!refs.treeStatus) return;
    refs.treeStatus.hidden = !message;
    refs.treeStatus.classList.toggle("is-error", Boolean(isError));
    refs.treeStatus.textContent = message || "";
  }

  function showPasswordStatus(message, isError) {
    if (!refs.passwordStatus) return;
    refs.passwordStatus.hidden = !message;
    refs.passwordStatus.classList.toggle("is-error", Boolean(isError));
    refs.passwordStatus.textContent = message || "";
  }

  function iconSvg(type) {
    if (type === "homepage") {
      return '<svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.6a.4.4 0 0 1-.4-.4V15a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v5.6a.4.4 0 0 1-.4.4H5a1 1 0 0 1-1-1v-9.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    }
    if (type === "section") {
      return '<svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l1.6 1.7H19A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17v-9.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" width="16" height="16" aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  }

  function renderStatusIcon(page) {
    var status = String(page.status || "queued");
    if (status === "processing") {
      return '<span class="tree-status is-processing"><span class="tree-spinner" aria-hidden="true"></span></span>';
    }
    if (status === "ready") {
      var justReady = page.justReadyUntil && Date.now() < page.justReadyUntil;
      return '<span class="tree-status is-ready ' + (justReady ? "is-just-ready" : "") + '">✓</span>';
    }
    if (status === "failed") {
      return '<span class="tree-status is-failed">!</span>';
    }
    return '<span class="tree-status" title="Locked">🔒</span>';
  }

  function createIndent(depth) {
    var html = "";
    for (var i = 0; i < depth; i += 1) {
      html += '<span class="tree-indent" aria-hidden="true"></span>';
    }
    return html;
  }

  function createTreeRow(page, depth) {
    var row = document.createElement("div");
    row.className = "tree-row" + (state.selectedId === page.id ? " is-selected" : "");
    row.setAttribute("role", "treeitem");
    row.setAttribute("data-id", page.id);
    row.setAttribute("data-type", page.type);
    row.setAttribute("aria-selected", state.selectedId === page.id ? "true" : "false");

    var left = document.createElement("div");
    left.className = "tree-row-left";
    left.innerHTML = createIndent(depth);

    if (page.type === "section") {
      var expander = document.createElement("button");
      expander.type = "button";
      expander.className = "tree-expander";
      expander.setAttribute("aria-label", state.collapsedSections[page.id] ? "Expand section" : "Collapse section");
      expander.textContent = state.collapsedSections[page.id] ? "▸" : "▾";
      expander.addEventListener("click", function (event) {
        event.stopPropagation();
        state.collapsedSections[page.id] = !state.collapsedSections[page.id];
        renderTree();
      });
      left.appendChild(expander);
    } else {
      left.insertAdjacentHTML("beforeend", '<span class="tree-indent" aria-hidden="true"></span>');
    }

    var icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = iconSvg(page.type);
    left.appendChild(icon);

    var title = document.createElement("p");
    title.className = "tree-title";
    title.textContent = page.title;
    left.appendChild(title);

    var right = document.createElement("div");
    right.className = "tree-row-right";
    right.insertAdjacentHTML("beforeend", renderStatusIcon(page));

    if (page.type !== "homepage") {
      var moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "tree-more-btn";
      moreBtn.setAttribute("aria-label", "Page options");
      moreBtn.textContent = "⋯";
      moreBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        openContextMenu(page.id, event.currentTarget);
      });
      right.appendChild(moreBtn);
    }

    row.appendChild(left);
    row.appendChild(right);
    row.addEventListener("click", function () {
      state.selectedId = page.id;
      closeContextMenu();
      renderViewer();
      renderTree();
    });

    return row;
  }

  function renderTreeBranch(parentId, depth, fragment) {
    var children = getChildren(parentId);
    children.forEach(function (page) {
      fragment.appendChild(createTreeRow(page, depth));
      if (page.type === "section" && !state.collapsedSections[page.id]) {
        renderTreeBranch(page.id, depth + 1, fragment);
      }
    });
  }

  function renderTree() {
    if (!refs.tree) return;
    refs.tree.innerHTML = "";
    var fragment = document.createDocumentFragment();
    renderTreeBranch(null, 0, fragment);
    refs.tree.appendChild(fragment);
  }

  function renderProgress() {
    if (!state.project) return;

    var usage = getUsage();
    var progress = inferProgress();
    if (refs.progressFill) refs.progressFill.style.width = progress + "%";
    if (refs.progressCopy) refs.progressCopy.textContent = progress + "% complete";
    if (refs.detectedPages) refs.detectedPages.textContent = String(state.project.detectedPages || 0);
    if (refs.purchasedPages) refs.purchasedPages.textContent = String(usage.purchased);
    if (refs.usedPages) refs.usedPages.textContent = String(usage.used);
    if (refs.remainingPages) refs.remainingPages.textContent = String(usage.remaining);
    if (refs.addPageBtn) refs.addPageBtn.disabled = usage.remaining <= 0;
  }

  function statusPillLabel(status) {
    if (!status) return "queued";
    return String(status).toLowerCase();
  }

  function renderSectionState(section) {
    var children = getChildren(section.id);
    var listHtml = "";
    if (!children.length) {
      listHtml = '<p>No pages in this section yet.</p>';
    } else {
      listHtml =
        '<ul class="viewer-section-list">' +
        children.map(function (child) {
          return (
            '<li class="viewer-section-item">' +
            "<strong>" + escapeHtml(child.title) + "</strong>" +
            "<span>" + escapeHtml(statusPillLabel(child.status)) + "</span>" +
            "</li>"
          );
        }).join("") +
        "</ul>";
    }

    return (
      '<div class="viewer-placeholder">' +
      '<div>' +
      "<h3 style=\"margin:0 0 8px;\">Section: " + escapeHtml(section.title) + "</h3>" +
      "<p style=\"margin:0;\">Select a page or add a new page inside this section.</p>" +
      listHtml +
      "</div>" +
      "</div>"
    );
  }

  function renderPreviewForPage(page) {
    if (page.status === "processing" || page.status === "queued") {
      return (
        '<div class="viewer-placeholder">' +
        '<div>' +
        "<p style=\"margin:0 0 8px;\"><strong>This page is still processing.</strong></p>" +
        "<p style=\"margin:0;\">We are preparing the screenshot preview.</p>" +
        "</div>" +
        "</div>"
      );
    }
    if (page.status === "failed") {
      return (
        '<div class="viewer-placeholder">' +
        '<div>' +
        "<p style=\"margin:0 0 8px;\"><strong>Preview failed for this page.</strong></p>" +
        "<p style=\"margin:0;\">Try again later.</p>" +
        "</div>" +
        "</div>"
      );
    }

    if (!page.screenshotUrl) {
      return (
        '<div class="viewer-placeholder">' +
        '<div>' +
        "<p style=\"margin:0 0 8px;\"><strong>No screenshot available yet.</strong></p>" +
        "<p style=\"margin:0;\">Screenshot will appear here when ready.</p>" +
        "</div>" +
        "</div>"
      );
    }

    return (
      '<div class="viewer-browser">' +
      '<div class="viewer-browser-top">' +
      '<span class="viewer-dot dot-a"></span>' +
      '<span class="viewer-dot dot-b"></span>' +
      '<span class="viewer-dot dot-c"></span>' +
      "</div>" +
      '<div class="viewer-scroll">' +
      '<img alt="Page screenshot preview" src="' + page.screenshotUrl + '">' +
      "</div>" +
      "</div>"
    );
  }

  function renderViewer() {
    if (!state.project || !refs.viewerContent) return;
    var selected = getById(state.selectedId) || state.pages[0];
    if (!selected) return;
    state.selectedId = selected.id;

    if (refs.selectedTitle) refs.selectedTitle.textContent = selected.title || "Untitled";
    if (refs.selectedStatusPill) {
      refs.selectedStatusPill.textContent = statusPillLabel(selected.status);
      refs.selectedStatusPill.setAttribute("data-status", statusPillLabel(selected.status));
    }
    if (refs.selectedUrlPill) refs.selectedUrlPill.textContent = selected.url || (state.project.wordpressUrl || "");
    if (refs.selectedPagesPill) {
      refs.selectedPagesPill.textContent = String(state.project.detectedPages || 0) + " pages detected";
    }

    if (selected.type === "section") {
      refs.viewerContent.innerHTML = renderSectionState(selected);
      return;
    }
    refs.viewerContent.innerHTML = renderPreviewForPage(selected);
  }

  function normalizeSiblingOrder(parentId) {
    var siblings = getChildren(parentId);
    siblings.forEach(function (sibling, index) {
      sibling.orderIndex = index;
    });
  }

  function createPageId() {
    return "page_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }

  function createPageTitle() {
    var count = state.pages.filter(function (page) {
      return page.type === "page";
    }).length + 1;
    return "New page " + count;
  }

  function buildPageUrl(title) {
    var root = String(state.project && state.project.wordpressUrl ? state.project.wordpressUrl : "").trim();
    var slug = String(title || "new-page")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!root) return "";
    try {
      var base = new URL(root);
      return base.origin + "/" + slug;
    } catch (_error) {
      return root + "/" + slug;
    }
  }

  function scheduleReadyState(pageId, delay) {
    if (state.timers[pageId]) return;
    var ms = Number.isFinite(delay) ? delay : (1800 + Math.round(Math.random() * 1800));
    state.timers[pageId] = window.setTimeout(function () {
      var page = getById(pageId);
      if (page && (page.status === "processing" || page.status === "queued")) {
        page.status = "ready";
        page.justReadyUntil = Date.now() + 1200;
        renderAll();
      }
      if (state.timers[pageId]) {
        window.clearTimeout(state.timers[pageId]);
        delete state.timers[pageId];
      }
    }, ms);
  }

  function queuePageProcessing(pageId) {
    var page = getById(pageId);
    if (!page) return;
    page.status = "processing";
    renderAll();
    scheduleReadyState(pageId);
  }

  function addPage() {
    var usage = getUsage();
    if (usage.remaining <= 0) {
      showTreeStatus("No remaining purchased pages. Delete a page to free one slot.", true);
      return;
    }
    showTreeStatus("", false);

    var selected = getById(state.selectedId);
    var parentId = selected && selected.type === "section" ? selected.id : null;
    var siblings = getChildren(parentId);
    var newPage = {
      id: createPageId(),
      title: createPageTitle(),
      url: buildPageUrl(createPageTitle()),
      type: "page",
      parentId: parentId,
      status: "queued",
      screenshotUrl: String(state.project && state.project.previewImageUrl ? state.project.previewImageUrl : ""),
      orderIndex: siblings.length
    };
    state.pages.push(newPage);
    state.selectedId = newPage.id;
    renderAll();
    queuePageProcessing(newPage.id);
  }

  function swapSibling(direction, targetId) {
    var target = getById(targetId);
    if (!target || target.type === "homepage") return;
    var siblings = getChildren(target.parentId);
    var index = siblings.findIndex(function (item) { return item.id === target.id; });
    if (index < 0) return;
    var swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= siblings.length) return;

    var current = siblings[index];
    var next = siblings[swapIndex];
    var temp = current.orderIndex;
    current.orderIndex = next.orderIndex;
    next.orderIndex = temp;
    normalizeSiblingOrder(target.parentId);
    renderAll();
  }

  function collectDescendants(sectionId) {
    var all = [];
    var queue = [sectionId];
    while (queue.length) {
      var next = queue.shift();
      if (!next) continue;
      var children = state.pages.filter(function (page) {
        return page.parentId === next;
      });
      children.forEach(function (child) {
        all.push(child.id);
        if (child.type === "section") {
          queue.push(child.id);
        }
      });
    }
    return all;
  }

  function deleteNode(targetId) {
    var target = getById(targetId);
    if (!target || target.type === "homepage") return;

    var idsToDelete = [target.id];
    if (target.type === "section") {
      idsToDelete = idsToDelete.concat(collectDescendants(target.id));
    }

    state.pages = state.pages.filter(function (page) {
      return idsToDelete.indexOf(page.id) === -1;
    });
    normalizeSiblingOrder(target.parentId);
    if (!getById(state.selectedId)) {
      var homepage = state.pages.find(function (page) { return page.type === "homepage"; });
      state.selectedId = homepage ? homepage.id : (state.pages[0] ? state.pages[0].id : "");
    }
    renderAll();
  }

  function convertPageToSection(targetId) {
    var page = getById(targetId);
    if (!page || page.type !== "page") return;
    page.type = "section";
    page.status = "ready";
    page.screenshotUrl = "";
    if (!state.collapsedSections[page.id]) {
      state.collapsedSections[page.id] = false;
    }
    renderAll();
  }

  function createContextAction(label, onClick, danger) {
    var action = document.createElement("button");
    action.type = "button";
    action.className = "context-action" + (danger ? " is-danger" : "");
    action.textContent = label;
    action.addEventListener("click", function () {
      closeContextMenu();
      onClick();
    });
    return action;
  }

  function openContextMenu(pageId, anchor) {
    if (!refs.contextMenu) return;
    var target = getById(pageId);
    if (!target) return;

    state.contextTargetId = pageId;
    refs.contextMenu.innerHTML = "";
    var rect = anchor.getBoundingClientRect();
    refs.contextMenu.style.top = Math.round(rect.bottom + 6) + "px";
    refs.contextMenu.style.left = Math.round(rect.left - 148) + "px";

    if (target.type === "page") {
      refs.contextMenu.appendChild(createContextAction("Convert to section", function () {
        convertPageToSection(target.id);
      }, false));
      refs.contextMenu.appendChild(createContextAction("Move up", function () {
        swapSibling("up", target.id);
      }, false));
      refs.contextMenu.appendChild(createContextAction("Move down", function () {
        swapSibling("down", target.id);
      }, false));
      refs.contextMenu.appendChild(createContextAction("Delete page", function () {
        deleteNode(target.id);
      }, true));
    } else if (target.type === "section") {
      refs.contextMenu.appendChild(createContextAction("Move up", function () {
        swapSibling("up", target.id);
      }, false));
      refs.contextMenu.appendChild(createContextAction("Move down", function () {
        swapSibling("down", target.id);
      }, false));
      refs.contextMenu.appendChild(createContextAction("Delete section", function () {
        deleteNode(target.id);
      }, true));
    }

    refs.contextMenu.hidden = false;
  }

  function closeContextMenu() {
    if (!refs.contextMenu) return;
    refs.contextMenu.hidden = true;
    refs.contextMenu.innerHTML = "";
    state.contextTargetId = "";
  }

  async function loadProjectAreaData() {
    var url =
      "/api/project-area-data?project=" + encodeURIComponent(state.projectId) +
      "&token=" + encodeURIComponent(state.token);
    var response = await fetch(url, { method: "GET", credentials: "same-origin" });
    var data = await response.json();
    if (!response.ok) {
      throw new Error((data && data.error) || "Could not load Project Area data.");
    }
    return data;
  }

  function clearTimers() {
    Object.keys(state.timers).forEach(function (key) {
      window.clearTimeout(state.timers[key]);
      delete state.timers[key];
    });
  }

  function bootProcessingSimulation() {
    clearTimers();
    var processingItems = state.pages.filter(function (page) {
      return page.type === "page" && (page.status === "processing" || page.status === "queued");
    });
    processingItems.forEach(function (page, index) {
      scheduleReadyState(page.id, 1400 + (index * 700));
    });
  }

  function renderAll() {
    renderProgress();
    renderTree();
    renderViewer();
  }

  async function handlePasswordUpdateClick() {
    showPasswordStatus("", false);
    if (!refs.updatePasswordBtn) return;
    refs.updatePasswordBtn.disabled = true;
    try {
      var response = await fetch("/api/project-area-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: state.projectId,
          token: state.token
        })
      });
      var payload = await response.json();
      if (!response.ok) {
        throw new Error((payload && payload.error) || "Could not send password update email.");
      }
      showPasswordStatus("Password update email sent to " + payload.sentTo + ".", false);
    } catch (error) {
      showPasswordStatus(error && error.message ? error.message : "Could not send password update email.", true);
    } finally {
      refs.updatePasswordBtn.disabled = false;
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function init() {
    clearLegacyQuoteState();
    var access = parseAccessFromUrl();
    state.projectId = access.project;
    state.token = access.token;
    if (!state.projectId || !state.token) {
      setFatalMessage("Session expired. Please check your email for your project access link.");
      return;
    }

    try {
      var data = await loadProjectAreaData();
      state.project = data;
      state.pages = Array.isArray(data.pages)
        ? data.pages.map(normalizePage)
        : [];
      if (!state.pages.length) {
        setFatalMessage("Project data is empty. Please check your email for your project access link.");
        return;
      }
      var homepage = state.pages.find(function (item) { return item.type === "homepage"; });
      state.selectedId = homepage ? homepage.id : state.pages[0].id;

      if (refs.domain) {
        refs.domain.textContent = String((data.wordpressUrl || "").replace(/^https?:\/\//i, "") || "project");
      }

      renderAll();
      bootProcessingSimulation();
    } catch (error) {
      setFatalMessage(error && error.message ? error.message : "Session expired. Please check your email for your project access link.");
    }
  }

  if (refs.addPageBtn) {
    refs.addPageBtn.addEventListener("click", addPage);
  }

  if (refs.updatePasswordBtn) {
    refs.updatePasswordBtn.addEventListener("click", handlePasswordUpdateClick);
  }

  document.addEventListener("click", function (event) {
    var insideMenu = refs.contextMenu && refs.contextMenu.contains(event.target);
    var trigger = event.target && event.target.closest && event.target.closest(".tree-more-btn");
    if (!insideMenu && !trigger) {
      closeContextMenu();
    }
  });

  window.addEventListener("beforeunload", clearTimers);
  init();
})();
