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
    now: Date.now(),
    renamingId: "",
    renameDraft: "",
    renameOriginal: "",
    renameSavingId: "",
    draggingId: "",
    dropTarget: null,
    savingTree: false,
    processingPageRequest: false,
    pollTimer: 0,
    pollInFlight: false,
    manualScanDrafts: {},
    manualScanStatusByPageId: {}
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
    viewerContent: document.querySelector("#viewer-content"),
    contextMenu: document.querySelector("#page-context-menu"),
    accountMenuToggle: document.querySelector("#account-menu-toggle"),
    accountMenu: document.querySelector("#account-menu"),
    accountUpdateEmailBtn: document.querySelector("#account-update-email-btn"),
    accountUpgradeBtn: document.querySelector("#account-upgrade-btn"),
    accountEmail: document.querySelector("#account-email"),
    logoutBtn: document.querySelector("#logout-btn"),
    sendAccessLinkBtn: document.querySelector("#send-access-link-btn"),
    accountStatus: document.querySelector("#account-status"),
    accessModal: document.querySelector("#access-modal"),
    accessModalBackdrop: document.querySelector("#access-modal-backdrop"),
    accessModalClose: document.querySelector("#access-modal-close"),
    accessModalBack: document.querySelector("#access-modal-back"),
    accessModalSubmit: document.querySelector("#access-modal-submit"),
    accessModalStatus: document.querySelector("#access-modal-status"),
    accessEmailInput: document.querySelector("#access-email-input"),
    emailUpdateModal: document.querySelector("#email-update-modal"),
    emailUpdateModalBackdrop: document.querySelector("#email-update-modal-backdrop"),
    emailUpdateModalClose: document.querySelector("#email-update-modal-close"),
    emailUpdateCancel: document.querySelector("#email-update-cancel"),
    emailUpdateSubmit: document.querySelector("#email-update-submit"),
    emailUpdateStatus: document.querySelector("#email-update-status"),
    newEmailInput: document.querySelector("#new-email-input"),
    confirmEmailInput: document.querySelector("#confirm-email-input")
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
    try {
      if (window.name && window.name.indexOf("wptoai.previewState=") === 0) {
        window.name = "";
      }
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
      persisted: safe.persisted !== false,
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

  function snapshotPages() {
    return state.pages.map(function (page) {
      return Object.assign({}, page);
    });
  }

  function restorePages(snapshot) {
    state.pages = Array.isArray(snapshot)
      ? snapshot.map(function (page, index) { return normalizePage(page, index); })
      : [];
  }

  function replacePageState(nextPage) {
    if (!nextPage || !nextPage.id) return;
    state.pages = state.pages.map(function (page, index) {
      if (page.id !== nextPage.id) return page;
      var normalized = normalizePage(nextPage, index);
      normalized.type = nextPage.type || page.type;
      normalized.justReadyUntil = page.justReadyUntil || 0;
      if (
        normalized.status === "ready" &&
        normalized.screenshotUrl &&
        (page.status !== "ready" || !page.screenshotUrl)
      ) {
        normalized.justReadyUntil = Date.now() + 1200;
        scheduleReadyIndicatorClear(normalized.id, 1240);
      }
      return normalized;
    });
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

  function isPurchasedPageType(type) {
    return type === "homepage" || type === "page" || type === "section";
  }

  function isRealPageType(type) {
    return type === "homepage" || type === "page";
  }

  function hasReadyScreenshot(page) {
    return Boolean(
      page &&
      page.status === "ready" &&
      String(page.screenshotUrl || "").trim()
    );
  }

  function getUsage() {
    var used = state.pages.filter(function (page) {
      return isPurchasedPageType(page.type);
    }).length;
    var purchased = Number(
      state.project && (
        state.project.purchasedPageCount ||
        state.project.purchasedPages
      ) ? (
        state.project.purchasedPageCount ||
        state.project.purchasedPages
      ) : 0
    );
    var remaining = Math.max(0, purchased - used);
    return { used: used, purchased: purchased, remaining: remaining };
  }

  function inferProgress() {
    var total = Number(
      state.project && (
        state.project.totalRealPageCount ||
        state.project.detectedPages
      ) ? (
        state.project.totalRealPageCount ||
        state.project.detectedPages
      ) : 0
    );
    if (total <= 0) return 0;
    var readyCount = state.pages.filter(function (page) {
      return isRealPageType(page.type) && hasReadyScreenshot(page);
    }).length;
    return Math.max(0, Math.min(100, Math.round((readyCount / total) * 100)));
  }

  function pageNeedsQueue(page) {
    return Boolean(
      page &&
      isRealPageType(page.type) &&
      String(page.url || "").trim() &&
      !hasReadyScreenshot(page) &&
      (page.status === "queued" || page.status === "processing")
    );
  }

  function hasQueueActivity(project, pages) {
    if (project && typeof project.queueActive === "boolean") {
      return project.queueActive;
    }
    return Array.isArray(pages) && pages.some(pageNeedsQueue);
  }

  function updateProjectSummary(summary) {
    if (!summary || !state.project) return;
    state.project = Object.assign({}, state.project, summary);
  }

  function showTreeStatus(message, isError) {
    if (!refs.treeStatus) return;
    refs.treeStatus.hidden = !message;
    refs.treeStatus.classList.toggle("is-error", Boolean(isError));
    refs.treeStatus.textContent = message || "";
  }

  function showAccessModalStatus(message, isError) {
    if (!refs.accessModalStatus) return;
    refs.accessModalStatus.hidden = !message;
    refs.accessModalStatus.classList.toggle("is-error", Boolean(isError));
    refs.accessModalStatus.textContent = message || "";
  }

  function showAccountStatus(message, isError) {
    if (!refs.accountStatus) return;
    refs.accountStatus.hidden = !message;
    refs.accountStatus.classList.toggle("is-error", Boolean(isError));
    refs.accountStatus.textContent = message || "";
  }

  function showEmailUpdateStatus(message, isError) {
    if (!refs.emailUpdateStatus) return;
    refs.emailUpdateStatus.hidden = !message;
    refs.emailUpdateStatus.classList.toggle("is-error", Boolean(isError));
    refs.emailUpdateStatus.textContent = message || "";
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
      if (justReady) {
        return '<span class="tree-status is-ready is-just-ready">✓</span>';
      }
      return "";
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
    if (state.contextTargetId === page.id) {
      row.className += " is-context-open";
    }
    row.setAttribute("role", "treeitem");
    row.setAttribute("data-id", page.id);
    row.setAttribute("data-type", page.type);
    row.setAttribute("aria-selected", state.selectedId === page.id ? "true" : "false");
    if (page.type === "page") {
      row.draggable = true;
    }

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

    if (state.renamingId === page.id) {
      var input = document.createElement("input");
      input.type = "text";
      input.className = "tree-title-input";
      input.setAttribute("data-id", page.id);
      input.value = state.renameDraft || page.title || "";
      input.addEventListener("click", function (event) {
        event.stopPropagation();
      });
      input.addEventListener("input", function (event) {
        state.renameDraft = event.target.value;
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelRename();
        }
      });
      input.addEventListener("blur", function () {
        if (state.renamingId !== page.id) return;
        persistRename(page.id, input.value, state.renameOriginal || page.title || "");
      });
      left.appendChild(input);
    } else {
      var title = document.createElement("p");
      title.className = "tree-title";
      title.textContent = page.title;
      left.appendChild(title);
    }

    var right = document.createElement("div");
    right.className = "tree-row-right";
    right.insertAdjacentHTML("beforeend", renderStatusIcon(page));

    if (page.type !== "homepage") {
      var moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "tree-more-btn";
      moreBtn.setAttribute("aria-label", "Page options");
      moreBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="6.5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="17.5" cy="12" r="1.6"></circle></svg>';
      moreBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        openContextMenu(page.id, event.currentTarget);
      });
      right.appendChild(moreBtn);
    }

    row.appendChild(left);
    row.appendChild(right);
    row.addEventListener("click", function () {
      if (state.renamingId === page.id) return;
      state.selectedId = page.id;
      closeContextMenu();
      renderViewer();
      renderTree();
    });

    if (page.type === "page") {
      row.addEventListener("dragstart", function (event) {
        if (state.renamingId || state.savingTree) {
          event.preventDefault();
          return;
        }
        state.draggingId = page.id;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", page.id);
        }
        updateDropIndicators();
      });
    }

    row.addEventListener("dragover", function (event) {
      if (!state.draggingId) return;
      var dropMode = getDropMode(page, row, event.clientY);
      if (!isValidDrop(state.draggingId, page.id, dropMode)) {
        clearDropTarget();
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      setDropTarget(page.id, dropMode);
    });

    row.addEventListener("drop", function (event) {
      if (!state.draggingId) return;
      var targetId = state.dropTarget && state.dropTarget.pageId ? state.dropTarget.pageId : page.id;
      var dropMode = state.dropTarget && state.dropTarget.mode
        ? state.dropTarget.mode
        : getDropMode(page, row, event.clientY);
      if (!isValidDrop(state.draggingId, targetId, dropMode)) return;
      event.preventDefault();
      var draggedId = state.draggingId;
      state.draggingId = "";
      clearDropTarget();
      applyTreeMove(draggedId, targetId, dropMode);
    });

    row.addEventListener("dragend", function () {
      state.draggingId = "";
      clearDropTarget();
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
    updateDropIndicators();
  }

  function renderProgress() {
    if (!state.project) return;

    var usage = getUsage();
    var progress = inferProgress();
    if (refs.progressFill) refs.progressFill.style.width = progress + "%";
    if (refs.progressCopy) refs.progressCopy.textContent = progress + "% complete";
    if (refs.detectedPages) {
      refs.detectedPages.textContent = String(
        (state.project.totalRealPageCount || state.project.detectedPages || 0)
      );
    }
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

  function getManualScanDraft(page) {
    if (!page) return "";
    if (Object.prototype.hasOwnProperty.call(state.manualScanDrafts, page.id)) {
      return state.manualScanDrafts[page.id];
    }
    return String(page.url || "");
  }

  function getManualScanStatus(pageId) {
    return state.manualScanStatusByPageId[pageId] || null;
  }

  function setManualScanStatus(pageId, message, isError) {
    if (!pageId) return;
    if (!message) {
      delete state.manualScanStatusByPageId[pageId];
      return;
    }
    state.manualScanStatusByPageId[pageId] = {
      message: String(message || ""),
      isError: Boolean(isError)
    };
  }

  function shouldShowManualScan(page) {
    if (!page || page.type !== "page") return false;
    if (page.screenshotUrl) return false;
    return !String(page.url || "").trim() || page.status === "failed";
  }

  function renderManualScanState(page) {
    var status = getManualScanStatus(page.id);
    return (
      '<div class="viewer-manual-scan">' +
      '<div class="viewer-manual-copy">' +
      "<p style=\"margin:0 0 8px;\"><strong>Add a page URL to generate this screenshot.</strong></p>" +
      "<p style=\"margin:0;\">We will scan the page, upload the screenshot, and reuse it on future visits.</p>" +
      "</div>" +
      '<label class="viewer-field-label" for="manual-page-url-input">Page URL</label>' +
      '<input id="manual-page-url-input" class="viewer-url-input" type="url" value="' + escapeHtml(getManualScanDraft(page)) + '" placeholder="https://example.com/about">' +
      (status ? '<p class="viewer-form-status' + (status.isError ? ' is-error' : '') + '">' + escapeHtml(status.message) + '</p>' : '<p class="viewer-form-status" hidden></p>') +
      '<div class="viewer-form-actions">' +
      '<button id="manual-page-scan-btn" class="viewer-scan-btn" type="button">' +
      (page.status === "processing" ? "Scanning..." : "Scan") +
      "</button>" +
      "</div>" +
      "</div>"
    );
  }

  function renderPreviewForPage(page) {
    if (shouldShowManualScan(page)) {
      return renderManualScanState(page);
    }
    if (page.status === "processing" || page.status === "queued") {
      return (
        '<div class="viewer-placeholder">' +
        '<div>' +
        "<p style=\"margin:0 0 8px;\"><strong>" + (page.status === "processing" ? "This page is still processing." : "This page is queued for screenshot generation.") + "</strong></p>" +
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

  function bindViewerInteractions(selected) {
    if (!selected || !shouldShowManualScan(selected) || !refs.viewerContent) return;
    var urlInput = refs.viewerContent.querySelector("#manual-page-url-input");
    var scanButton = refs.viewerContent.querySelector("#manual-page-scan-btn");
    if (urlInput) {
      urlInput.addEventListener("input", function (event) {
        state.manualScanDrafts[selected.id] = event.target.value;
      });
      urlInput.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          handleManualPageScan(selected.id);
        }
      });
    }
    if (scanButton) {
      scanButton.disabled = selected.status === "processing";
      scanButton.addEventListener("click", function () {
        handleManualPageScan(selected.id);
      });
    }
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
    if (refs.selectedUrlPill) {
      refs.selectedUrlPill.textContent = selected.url ||
        (shouldShowManualScan(selected) ? "Add page URL" : (state.project.wordpressUrl || ""));
    }

    if (selected.type === "section" && !selected.screenshotUrl) {
      refs.viewerContent.innerHTML = renderSectionState(selected);
      return;
    }
    refs.viewerContent.innerHTML = renderPreviewForPage(selected);
    bindViewerInteractions(selected);
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

  function slugifyTitle(title) {
    return String(title || "page")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "page";
  }

  function buildRenamedPageUrl(page, title) {
    var slug = slugifyTitle(title);
    var currentUrl = String(page && page.url ? page.url : "").trim();
    if (!currentUrl) {
      return "";
    }
    if (currentUrl) {
      try {
        var parsed = new URL(currentUrl);
        var segments = parsed.pathname.split("/").filter(Boolean);
        if (!segments.length) {
          parsed.pathname = "/" + slug;
        } else {
          segments[segments.length - 1] = slug;
          parsed.pathname = "/" + segments.join("/");
        }
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch (_error) {
        // fall back to root-based URL below
      }
    }
    return buildPageUrl(slug);
  }

  function normalizeEditableTitle(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildTreeOrderPayload() {
    return state.pages
      .filter(function (page) {
        return page.type !== "homepage" && page.persisted !== false;
      })
      .map(function (page, index) {
        return {
          id: page.id,
          parentId: page.parentId || null,
          type: page.type || "page",
          orderIndex: Number.isFinite(page.orderIndex) ? page.orderIndex : index
        };
      });
  }

  async function persistTreeOrder(previousPages) {
    var pages = buildTreeOrderPayload();
    if (!pages.length || state.savingTree) return true;

    state.savingTree = true;
    showTreeStatus("", false);

    try {
      var response = await fetch("/api/project-area-page-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: state.projectId,
          token: state.token,
          pages: pages
        })
      });
      var payload = await response.json();
      if (!response.ok) {
        throw new Error((payload && payload.error) || "Could not save page order.");
      }
      return true;
    } catch (error) {
      restorePages(previousPages);
      renderAll();
      console.error("PROJECT_AREA_TREE_ORDER_SAVE_ERROR", error && error.message ? error.message : error);
      return false;
    } finally {
      state.savingTree = false;
    }
  }

  async function persistRename(pageId, nextTitle, previousTitle) {
    var page = getById(pageId);
    if (!page || state.renameSavingId === pageId) return;

    var normalizedTitle = normalizeEditableTitle(nextTitle);
    var nextUrl = buildRenamedPageUrl(page, normalizedTitle);
    var previousUrl = page.url || "";
    state.renameSavingId = pageId;
    state.renamingId = "";
    state.renameDraft = "";
    state.renameOriginal = "";

    if (!normalizedTitle) {
      page.title = previousTitle;
      renderAll();
      showTreeStatus("Page name cannot be empty.", true);
      state.renameSavingId = "";
      return;
    }

    if (normalizedTitle === normalizeEditableTitle(previousTitle)) {
      page.title = previousTitle;
      renderAll();
      state.renameSavingId = "";
      return;
    }

    page.title = normalizedTitle;
    page.url = nextUrl;
    renderAll();
    showTreeStatus("", false);

    if (page.persisted === false) {
      state.renameSavingId = "";
      return;
    }

    try {
      var response = await fetch("/api/project-area-page-rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: state.projectId,
          token: state.token,
          pageId: pageId,
          title: normalizedTitle,
          url: nextUrl
        })
      });
      var payload = await response.json();
      if (!response.ok) {
        throw new Error((payload && payload.error) || "Could not rename page.");
      }
      replacePageState(payload && payload.page ? payload.page : null);
      renderAll();
    } catch (error) {
      page.title = previousTitle;
      page.url = previousUrl;
      renderAll();
      showTreeStatus(error && error.message ? error.message : "Could not rename page.", true);
    } finally {
      state.renameSavingId = "";
    }
  }

  function focusRenameInput(pageId) {
    if (!refs.tree || !pageId) return;
    var input = refs.tree.querySelector('.tree-title-input[data-id="' + pageId + '"]');
    if (!input) return;
    input.focus();
    input.select();
  }

  function startRename(pageId) {
    var page = getById(pageId);
    if (!page || page.type === "homepage") return;
    state.renamingId = pageId;
    state.renameDraft = page.title || "";
    state.renameOriginal = page.title || "";
    closeContextMenu();
    renderAll();
    window.requestAnimationFrame(function () {
      focusRenameInput(pageId);
    });
  }

  function cancelRename() {
    state.renamingId = "";
    state.renameDraft = "";
    state.renameOriginal = "";
    renderAll();
  }

  function getDropMode(page, row, clientY) {
    if (!page || !row) return "";
    var rect = row.getBoundingClientRect();
    var offset = clientY - rect.top;
    var ratio = rect.height > 0 ? offset / rect.height : 0.5;
    if (page.type === "section" && ratio > 0.26 && ratio < 0.74) {
      return "inside";
    }
    return ratio <= 0.5 ? "before" : "after";
  }

  function isValidDrop(pageId, targetId, mode) {
    var page = getById(pageId);
    var target = getById(targetId);
    if (!page || !target || page.id === target.id) return false;
    if (page.type !== "page") return false;
    if (mode === "inside") return target.type === "section";
    return mode === "before" || mode === "after";
  }

  function updateDropIndicators() {
    if (!refs.tree) return;
    var rows = refs.tree.querySelectorAll(".tree-row");
    rows.forEach(function (row) {
      row.classList.remove("is-drop-before", "is-drop-after", "is-drop-folder-target", "is-dragging");
      if (state.draggingId && row.getAttribute("data-id") === state.draggingId) {
        row.classList.add("is-dragging");
      }
      if (
        state.dropTarget &&
        state.dropTarget.pageId &&
        row.getAttribute("data-id") === state.dropTarget.pageId
      ) {
        if (state.dropTarget.mode === "inside") {
          row.classList.add("is-drop-folder-target");
        } else if (state.dropTarget.mode === "before") {
          row.classList.add("is-drop-before");
        } else if (state.dropTarget.mode === "after") {
          row.classList.add("is-drop-after");
        }
      }
    });

    if (state.dropTarget && state.dropTarget.mode === "root") {
      refs.tree.classList.add("is-root-drop-target");
    } else {
      refs.tree.classList.remove("is-root-drop-target");
    }
  }

  function setDropTarget(pageId, mode) {
    var next = pageId || mode === "root"
      ? { pageId: pageId || "", mode: mode || "" }
      : null;
    var currentPageId = state.dropTarget && state.dropTarget.pageId ? state.dropTarget.pageId : "";
    var currentMode = state.dropTarget && state.dropTarget.mode ? state.dropTarget.mode : "";
    var nextPageId = next && next.pageId ? next.pageId : "";
    var nextMode = next && next.mode ? next.mode : "";
    if (currentPageId === nextPageId && currentMode === nextMode) return;
    state.dropTarget = next;
    updateDropIndicators();
  }

  function clearDropTarget() {
    state.dropTarget = null;
    updateDropIndicators();
  }

  function closeAccountMenu() {
    if (!refs.accountMenu || refs.accountMenu.hidden) return;
    refs.accountMenu.hidden = true;
    if (refs.accountMenuToggle) {
      refs.accountMenuToggle.setAttribute("aria-expanded", "false");
    }
    console.log("ACCOUNT_MENU_CLOSED");
  }

  function openAccountMenu() {
    if (!refs.accountMenu || !refs.accountMenu.hidden) return;
    refs.accountMenu.hidden = false;
    if (refs.accountMenuToggle) {
      refs.accountMenuToggle.setAttribute("aria-expanded", "true");
    }
    console.log("ACCOUNT_MENU_OPENED");
  }

  function toggleAccountMenu() {
    if (!refs.accountMenu) return;
    if (refs.accountMenu.hidden) {
      openAccountMenu();
      return;
    }
    closeAccountMenu();
  }

  function closeEmailUpdateModal() {
    if (refs.emailUpdateModal) refs.emailUpdateModal.hidden = true;
    if (refs.emailUpdateSubmit) refs.emailUpdateSubmit.disabled = false;
    if (refs.emailUpdateCancel) refs.emailUpdateCancel.disabled = false;
    if (refs.emailUpdateModalClose) refs.emailUpdateModalClose.disabled = false;
    if (refs.newEmailInput) refs.newEmailInput.value = "";
    if (refs.confirmEmailInput) refs.confirmEmailInput.value = "";
    showEmailUpdateStatus("", false);
  }

  function openEmailUpdateModal() {
    closeAccountMenu();
    showAccountStatus("", false);
    showEmailUpdateStatus("", false);
    if (refs.newEmailInput) refs.newEmailInput.value = "";
    if (refs.confirmEmailInput) refs.confirmEmailInput.value = "";
    if (refs.emailUpdateModal) refs.emailUpdateModal.hidden = false;
    window.requestAnimationFrame(function () {
      if (refs.newEmailInput) refs.newEmailInput.focus();
    });
  }

  function renderAccount() {
    if (!refs.accountEmail) return;
    refs.accountEmail.textContent = String(
      (state.project && state.project.customerEmail) || "No email on file"
    );
    refs.accountEmail.title = refs.accountEmail.textContent;
    if (refs.accountMenuToggle) {
      refs.accountMenuToggle.title = refs.accountEmail.textContent;
    }
  }

  function scheduleReadyIndicatorClear(pageId, duration) {
    var timerKey = pageId + ":ready";
    if (state.timers[timerKey]) {
      window.clearTimeout(state.timers[timerKey]);
      delete state.timers[timerKey];
    }
    state.timers[timerKey] = window.setTimeout(function () {
      var page = getById(pageId);
      if (page) {
        page.justReadyUntil = 0;
        renderTree();
      }
      if (state.timers[timerKey]) {
        window.clearTimeout(state.timers[timerKey]);
        delete state.timers[timerKey];
      }
    }, Number.isFinite(duration) ? duration : 1300);
  }

  function movePageToTarget(pageId, targetId, mode) {
    var page = getById(pageId);
    var target = targetId ? getById(targetId) : null;
    if (!page || page.type !== "page") return false;

    var originalParentId = page.parentId || null;
    var originalSiblings = getChildren(originalParentId).filter(function (item) {
      return item.id !== page.id;
    });
    originalSiblings.forEach(function (sibling, index) {
      sibling.orderIndex = index;
    });

    var nextParentId = null;
    var insertIndex = 0;

    if (mode === "inside") {
      if (!target || target.type !== "section") return false;
      nextParentId = target.id;
      state.collapsedSections[target.id] = false;
      insertIndex = getChildren(nextParentId).filter(function (item) {
        return item.id !== page.id;
      }).length;
    } else if (mode === "root") {
      nextParentId = null;
      insertIndex = getChildren(null).filter(function (item) {
        return item.id !== page.id;
      }).length;
    } else {
      if (!target) return false;
      nextParentId = target.parentId || null;
      var nextSiblings = getChildren(nextParentId).filter(function (item) {
        return item.id !== page.id;
      });
      var targetIndex = nextSiblings.findIndex(function (item) {
        return item.id === target.id;
      });
      if (targetIndex < 0) {
        targetIndex = nextSiblings.length;
      }
      insertIndex = mode === "after" ? targetIndex + 1 : targetIndex;
    }

    page.parentId = nextParentId;
    var siblings = getChildren(nextParentId).filter(function (item) {
      return item.id !== page.id;
    });
    if (insertIndex < 0) insertIndex = 0;
    if (insertIndex > siblings.length) insertIndex = siblings.length;
    siblings.splice(insertIndex, 0, page);
    siblings.forEach(function (sibling, index) {
      sibling.orderIndex = index;
    });

    return true;
  }

  async function applyTreeMove(pageId, targetId, mode) {
    if (state.savingTree) return;
    var previousPages = snapshotPages();
    if (!movePageToTarget(pageId, targetId, mode)) {
      restorePages(previousPages);
      renderAll();
      return;
    }
    renderAll();
    await persistTreeOrder(previousPages);
  }

  async function requestProjectPageCreate(parentId) {
    var response = await fetch("/api/project-area-page-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: state.projectId,
        token: state.token,
        parentId: parentId || null
      })
    });
    var payload = await response.json();
    if (!response.ok) {
      throw new Error((payload && payload.error) || "Could not create page.");
    }
    return payload;
  }

  async function requestProjectPageScan(pageId, url) {
    var response = await fetch("/api/project-area-page-scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: state.projectId,
        token: state.token,
        pageId: pageId || null,
        url: url || null
      })
    });
    var payload = await response.json();
    if (!response.ok) {
      throw new Error((payload && payload.error) || "Could not process page.");
    }
    return payload;
  }

  function stopProjectPolling() {
    if (state.pollTimer) {
      window.clearTimeout(state.pollTimer);
      state.pollTimer = 0;
    }
  }

  function scheduleProjectPolling(delayMs) {
    stopProjectPolling();
    state.pollTimer = window.setTimeout(function () {
      state.pollTimer = 0;
      refreshProjectAreaDataPreservingUi();
    }, Number.isFinite(delayMs) ? delayMs : 3000);
  }

  function applyIncomingProjectAreaData(payload) {
    if (!payload || typeof payload !== "object") return;

    var previousPageMap = {};
    state.pages.forEach(function (page) {
      previousPageMap[page.id] = page;
    });

    state.project = Object.assign({}, payload);
    state.pages = Array.isArray(payload.pages)
      ? payload.pages.map(function (page, index) {
        var normalized = normalizePage(page, index);
        var previous = previousPageMap[normalized.id];
        if (previous && previous.justReadyUntil && Date.now() < previous.justReadyUntil) {
          normalized.justReadyUntil = previous.justReadyUntil;
        }
        if (
          previous &&
          normalized.status === "ready" &&
          normalized.screenshotUrl &&
          (previous.status !== "ready" || !previous.screenshotUrl)
        ) {
          normalized.justReadyUntil = Date.now() + 1200;
          scheduleReadyIndicatorClear(normalized.id, 1240);
        }
        return normalized;
      })
      : [];

    if (!getById(state.selectedId)) {
      var homepage = state.pages.find(function (item) { return item.type === "homepage"; });
      state.selectedId = homepage ? homepage.id : (state.pages[0] ? state.pages[0].id : "");
    }

    if (refs.domain) {
      refs.domain.textContent = String(
        ((payload.wordpressUrl || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "")) || "project"
      );
    }

    renderAll();
  }

  function applyProjectPagePayload(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.summary) {
      updateProjectSummary(payload.summary);
    }
    if (payload.page) {
      replacePageState(payload.page);
      delete state.manualScanDrafts[payload.page.id];
      setManualScanStatus(payload.page.id, "", false);
    }
  }

  async function processProjectQueueStep() {
    if (state.processingPageRequest) return;
    if (!hasQueueActivity(state.project, state.pages)) return;

    state.processingPageRequest = true;

    try {
      var payload = await requestProjectPageScan(null, null);
      applyProjectPagePayload(payload);
      renderAll();
    } catch (error) {
      console.error("PROJECT_QUEUE_STEP_ERROR", error && error.message ? error.message : error);
    } finally {
      state.processingPageRequest = false;
      if (hasQueueActivity(state.project, state.pages)) {
        scheduleProjectPolling(1200);
      } else {
        stopProjectPolling();
      }
    }
  }

  function startProjectPollingIfNeeded() {
    if (hasQueueActivity(state.project, state.pages)) {
      processProjectQueueStep();
      scheduleProjectPolling(3000);
      return;
    }
    stopProjectPolling();
  }

  async function refreshProjectAreaDataPreservingUi() {
    if (state.pollInFlight) return;
    if (!state.projectId || !state.token) return;
    if (state.draggingId || state.renamingId || state.renameSavingId || state.savingTree) {
      if (hasQueueActivity(state.project, state.pages)) {
        scheduleProjectPolling(3000);
      }
      return;
    }

    state.pollInFlight = true;

    try {
      var data = await loadProjectAreaData();
      applyIncomingProjectAreaData(data);
      if (hasQueueActivity(state.project, state.pages)) {
        processProjectQueueStep();
        scheduleProjectPolling(3000);
      } else {
        stopProjectPolling();
      }
    } catch (error) {
      if (error && error.code === "expired_access") {
        stopProjectPolling();
        openAccessModal();
      } else {
        console.error("PROJECT_AREA_POLL_ERROR", error && error.message ? error.message : error);
        if (hasQueueActivity(state.project, state.pages)) {
          scheduleProjectPolling(5000);
        }
      }
    } finally {
      state.pollInFlight = false;
    }
  }

  async function handleManualPageScan(pageId) {
    var page = getById(pageId);
    if (!page || page.type !== "page" || state.processingPageRequest) return;

    var nextUrl = String(getManualScanDraft(page) || page.url || "").trim();
    if (!/^https?:\/\/.+/i.test(nextUrl)) {
      setManualScanStatus(pageId, "Enter a valid page URL.", true);
      renderViewer();
      return;
    }

    state.processingPageRequest = true;
    setManualScanStatus(pageId, "", false);
    var previousUrl = page.url || "";
    var previousScreenshotUrl = page.screenshotUrl || "";
    page.url = nextUrl;
    page.status = "queued";
    page.screenshotUrl = "";
    page.justReadyUntil = 0;
    renderAll();

    try {
      var payload = await requestProjectPageScan(pageId, nextUrl);
      applyProjectPagePayload(payload);
      renderAll();
      startProjectPollingIfNeeded();
    } catch (error) {
      page.status = "failed";
      page.url = previousUrl || nextUrl;
      page.screenshotUrl = previousScreenshotUrl;
      setManualScanStatus(
        pageId,
        error && error.message ? error.message : "Could not scan this page right now.",
        true
      );
      renderAll();
    } finally {
      state.processingPageRequest = false;
    }
  }

  async function addPage() {
    var usage = getUsage();
    if (usage.remaining <= 0) {
      showTreeStatus("No remaining purchased pages. Delete a page to free one slot.", true);
      return;
    }
    showTreeStatus("", false);

    var selected = getById(state.selectedId);
    var parentId = selected && selected.type === "section" ? selected.id : null;

    if (refs.addPageBtn) refs.addPageBtn.disabled = true;
    try {
      var payload = await requestProjectPageCreate(parentId);
      var createdPage = normalizePage(payload && payload.page ? payload.page : null, state.pages.length);
      state.pages.push(createdPage);
      state.selectedId = createdPage.id;
      if (payload && payload.summary) {
        updateProjectSummary(payload.summary);
      }
      renderAll();
      startProjectPollingIfNeeded();
    } catch (error) {
      showTreeStatus(error && error.message ? error.message : "Could not create page.", true);
    } finally {
      if (refs.addPageBtn) refs.addPageBtn.disabled = false;
      renderProgress();
    }
  }

  async function swapSibling(direction, targetId) {
    var target = getById(targetId);
    if (!target || target.type === "homepage") return;
    var siblings = getChildren(target.parentId);
    var index = siblings.findIndex(function (item) { return item.id === target.id; });
    if (index < 0) return;
    var swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= siblings.length) return;

    var current = siblings[index];
    var next = siblings[swapIndex];
    var previousPages = snapshotPages();
    var temp = current.orderIndex;
    current.orderIndex = next.orderIndex;
    next.orderIndex = temp;
    normalizeSiblingOrder(target.parentId);
    renderAll();
    await persistTreeOrder(previousPages);
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

  async function convertPageToSection(targetId) {
    if (state.savingTree) return;
    var page = getById(targetId);
    if (!page || page.type !== "page") return;
    var previousPages = snapshotPages();
    page.type = "section";
    state.collapsedSections[page.id] = false;
    renderAll();
    if (page.persisted === false) return;
    await persistTreeOrder(previousPages);
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
    var row = anchor && anchor.closest ? anchor.closest(".tree-row") : null;
    if (row) {
      row.classList.add("is-context-open");
    }
    refs.contextMenu.innerHTML = "";
    var rect = anchor.getBoundingClientRect();
    refs.contextMenu.style.top = Math.round(rect.bottom + 6) + "px";
    refs.contextMenu.style.left = Math.round(rect.left - 148) + "px";

    if (target.type === "page") {
      refs.contextMenu.appendChild(createContextAction("Rename", function () {
        startRename(target.id);
      }, false));
      refs.contextMenu.appendChild(createContextAction("Convert to section", function () {
        convertPageToSection(target.id);
      }, false));
      refs.contextMenu.appendChild(createContextAction("Delete page", function () {
        deleteNode(target.id);
      }, true));
    } else if (target.type === "section") {
      refs.contextMenu.appendChild(createContextAction("Rename", function () {
        startRename(target.id);
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
    if (refs.tree) {
      var contextRows = refs.tree.querySelectorAll(".tree-row.is-context-open");
      contextRows.forEach(function (row) {
        row.classList.remove("is-context-open");
      });
    }
    state.contextTargetId = "";
  }

  async function loadProjectAreaData() {
    var url =
      "/api/project-area-data?project=" + encodeURIComponent(state.projectId) +
      "&token=" + encodeURIComponent(state.token);
    var response = await fetch(url, { method: "GET", credentials: "same-origin" });
    var data = await response.json();
    if (!response.ok) {
      var error = new Error((data && data.error) || "Could not load Project Area data.");
      if (response.status === 401) {
        error.code = "expired_access";
      }
      throw error;
    }
    return data;
  }

  function clearTimers() {
    Object.keys(state.timers).forEach(function (key) {
      window.clearTimeout(state.timers[key]);
      delete state.timers[key];
    });
  }

  function openAccessModal() {
    showAccountStatus("", false);
    showAccessModalStatus("", false);
    if (refs.accessEmailInput && !refs.accessEmailInput.value && state.project && state.project.customerEmail) {
      refs.accessEmailInput.value = String(state.project.customerEmail || "");
    }
    if (refs.accessModal) refs.accessModal.hidden = false;
    window.requestAnimationFrame(function () {
      if (refs.accessEmailInput) refs.accessEmailInput.focus();
    });
  }

  function closeAccessModal() {
    if (refs.accessModal) refs.accessModal.hidden = true;
    if (refs.accessModalSubmit) refs.accessModalSubmit.disabled = false;
    if (refs.accessModalBack) refs.accessModalBack.disabled = false;
    if (refs.accessModalClose) refs.accessModalClose.disabled = false;
    showAccessModalStatus("", false);
  }

  function exitAccessModal() {
    if (state.project) {
      closeAccessModal();
      return;
    }
    window.location.href = "/";
  }

  function renderAll() {
    renderProgress();
    renderAccount();
    renderTree();
    renderViewer();
  }

  function handleLogout() {
    stopProjectPolling();
    clearTimers();
    clearLegacyQuoteState();
    closeContextMenu();
    closeAccountMenu();
    closeAccessModal();
    closeEmailUpdateModal();
    state.projectId = "";
    state.token = "";
    state.project = null;
    state.pages = [];
    state.selectedId = "";
    try {
      window.location.replace("/");
    } catch (_error) {
      window.location.assign("/");
    }
  }

  async function requestAccessLinkForEmail(email) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a valid email to continue.");
    }

    var response = await fetch("/api/request-access-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email })
    });
    var payload = await response.json();
    if (!response.ok) {
      throw new Error((payload && payload.error) || "Could not send access link.");
    }
    return payload;
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  async function requestEmailUpdate(newEmail) {
    var response = await fetch("/api/request-email-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: state.projectId,
        token: state.token,
        newEmail: newEmail
      })
    });
    var payload = await response.json();
    if (!response.ok) {
      throw new Error((payload && payload.error) || "Could not request email update.");
    }
    return payload;
  }

  async function handleAccessModalSubmit() {
    showAccessModalStatus("", false);
    var email = refs.accessEmailInput ? String(refs.accessEmailInput.value || "").trim() : "";

    if (refs.accessModalSubmit) refs.accessModalSubmit.disabled = true;
    if (refs.accessModalBack) refs.accessModalBack.disabled = true;
    if (refs.accessModalClose) refs.accessModalClose.disabled = true;

    try {
      await requestAccessLinkForEmail(email);
      showAccessModalStatus("Access link sent. Check your email.", false);
    } catch (error) {
      showAccessModalStatus(error && error.message ? error.message : "Could not send access link.", true);
    } finally {
      if (refs.accessModalSubmit) refs.accessModalSubmit.disabled = false;
      if (refs.accessModalBack) refs.accessModalBack.disabled = false;
      if (refs.accessModalClose) refs.accessModalClose.disabled = false;
    }
  }

  async function handleAccountAccessLinkSend() {
    showAccountStatus("", false);
    closeAccountMenu();
    var email = state.project && state.project.customerEmail
      ? String(state.project.customerEmail || "").trim()
      : "";
    if (refs.sendAccessLinkBtn) refs.sendAccessLinkBtn.disabled = true;
    try {
      await requestAccessLinkForEmail(email);
      showAccountStatus("Access link sent. Check your email.", false);
    } catch (error) {
      showAccountStatus(error && error.message ? error.message : "Could not send access link.", true);
    } finally {
      if (refs.sendAccessLinkBtn) refs.sendAccessLinkBtn.disabled = false;
    }
  }

  async function handleEmailUpdateSubmit() {
    showEmailUpdateStatus("", false);
    var newEmail = refs.newEmailInput ? String(refs.newEmailInput.value || "").trim() : "";
    var confirmEmail = refs.confirmEmailInput ? String(refs.confirmEmailInput.value || "").trim() : "";

    if (!isValidEmail(newEmail)) {
      showEmailUpdateStatus("Enter a valid email address.", true);
      return;
    }
    if (String(newEmail).toLowerCase() !== String(confirmEmail).trim().toLowerCase()) {
      showEmailUpdateStatus("Emails must match.", true);
      return;
    }

    if (refs.emailUpdateSubmit) refs.emailUpdateSubmit.disabled = true;
    if (refs.emailUpdateCancel) refs.emailUpdateCancel.disabled = true;
    if (refs.emailUpdateModalClose) refs.emailUpdateModalClose.disabled = true;

    try {
      await requestEmailUpdate(newEmail);
      closeEmailUpdateModal();
      showAccountStatus("Verification link sent to your new email.", false);
    } catch (error) {
      showEmailUpdateStatus(
        error && error.message ? error.message : "Could not request email update.",
        true
      );
    } finally {
      if (refs.emailUpdateSubmit) refs.emailUpdateSubmit.disabled = false;
      if (refs.emailUpdateCancel) refs.emailUpdateCancel.disabled = false;
      if (refs.emailUpdateModalClose) refs.emailUpdateModalClose.disabled = false;
    }
  }

  function handleAccountUpdateEmailClick() {
    console.log("ACCOUNT_UPDATE_EMAIL_CLICKED");
    openEmailUpdateModal();
  }

  function handleUpgradeMaintenanceClick() {
    console.log("UPGRADE_MAINTENANCE_CLICKED");
    closeAccountMenu();
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
    stopProjectPolling();
    closeAccountMenu();
    closeAccessModal();
    closeEmailUpdateModal();
    showAccountStatus("", false);
    var access = parseAccessFromUrl();
    state.projectId = access.project;
    state.token = access.token;
    if (!state.projectId || !state.token) {
      setFatalMessage("Session expired. Please check your email for your project access link.");
      return;
    }

    try {
      var data = await loadProjectAreaData();
      applyIncomingProjectAreaData(data);
      if (!state.pages.length) {
        setFatalMessage("Project data is empty. Please check your email for your project access link.");
        return;
      }
      startProjectPollingIfNeeded();
    } catch (error) {
      if (error && error.code === "expired_access") {
        openAccessModal();
        return;
      }
      setFatalMessage(error && error.message ? error.message : "Session expired. Please check your email for your project access link.");
    }
  }

  if (refs.addPageBtn) {
    refs.addPageBtn.addEventListener("click", addPage);
  }

  if (refs.sendAccessLinkBtn) {
    refs.sendAccessLinkBtn.addEventListener("click", handleAccountAccessLinkSend);
  }

  if (refs.logoutBtn) {
    refs.logoutBtn.addEventListener("click", handleLogout);
  }

  if (refs.accountMenuToggle) {
    refs.accountMenuToggle.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleAccountMenu();
    });
  }

  if (refs.accountUpdateEmailBtn) {
    refs.accountUpdateEmailBtn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      handleAccountUpdateEmailClick();
    });
  }

  if (refs.accountUpgradeBtn) {
    refs.accountUpgradeBtn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      handleUpgradeMaintenanceClick();
    });
  }

  if (refs.accessModalBackdrop) {
    refs.accessModalBackdrop.addEventListener("click", exitAccessModal);
  }

  if (refs.accessModalClose) {
    refs.accessModalClose.addEventListener("click", exitAccessModal);
  }

  if (refs.accessModalBack) {
    refs.accessModalBack.addEventListener("click", exitAccessModal);
  }

  if (refs.accessModalSubmit) {
    refs.accessModalSubmit.addEventListener("click", handleAccessModalSubmit);
  }

  if (refs.accessEmailInput) {
    refs.accessEmailInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        handleAccessModalSubmit();
      }
    });
  }

  if (refs.emailUpdateModalBackdrop) {
    refs.emailUpdateModalBackdrop.addEventListener("click", closeEmailUpdateModal);
  }

  if (refs.emailUpdateModalClose) {
    refs.emailUpdateModalClose.addEventListener("click", closeEmailUpdateModal);
  }

  if (refs.emailUpdateCancel) {
    refs.emailUpdateCancel.addEventListener("click", closeEmailUpdateModal);
  }

  if (refs.emailUpdateSubmit) {
    refs.emailUpdateSubmit.addEventListener("click", handleEmailUpdateSubmit);
  }

  if (refs.newEmailInput) {
    refs.newEmailInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        handleEmailUpdateSubmit();
      }
    });
  }

  if (refs.confirmEmailInput) {
    refs.confirmEmailInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        handleEmailUpdateSubmit();
      }
    });
  }

  if (refs.tree) {
    refs.tree.addEventListener("dragover", function (event) {
      if (!state.draggingId) return;
      var row = event.target && event.target.closest ? event.target.closest(".tree-row") : null;
      if (row) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      setDropTarget("", "root");
    });

    refs.tree.addEventListener("drop", function (event) {
      if (!state.draggingId) return;
      var row = event.target && event.target.closest ? event.target.closest(".tree-row") : null;
      if (row) return;
      event.preventDefault();
      var draggedId = state.draggingId;
      state.draggingId = "";
      clearDropTarget();
      applyTreeMove(draggedId, "", "root");
    });
  }

  document.addEventListener("click", function (event) {
    var insideMenu = refs.contextMenu && refs.contextMenu.contains(event.target);
    var trigger = event.target && event.target.closest && event.target.closest(".tree-more-btn");
    if (!insideMenu && !trigger) {
      closeContextMenu();
    }
    var insideAccountMenu = refs.accountMenu && refs.accountMenu.contains(event.target);
    var accountTrigger = event.target && event.target.closest && event.target.closest("#account-menu-toggle");
    if (!insideAccountMenu && !accountTrigger) {
      closeAccountMenu();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && refs.emailUpdateModal && !refs.emailUpdateModal.hidden) {
      closeEmailUpdateModal();
      return;
    }
    if (event.key === "Escape" && refs.accessModal && !refs.accessModal.hidden) {
      exitAccessModal();
      return;
    }
    if (event.key === "Escape") {
      closeAccountMenu();
      closeContextMenu();
    }
  });

  window.addEventListener("beforeunload", function () {
    stopProjectPolling();
    clearTimers();
  });
  init();
})();
