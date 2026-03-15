const projectService = require("../services/project.service");
const projectAreaService = require("../services/projectArea.service");
const projectPublishService = require("../services/projectPublish.service");

const EXPIRED_MESSAGE = "Session expired. Please check your email for your project access link.";

function getBaseUrl(req) {
  return (
    process.env.BASE_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`
  );
}

function parseAccessParams(req) {
  const projectId = String((req.query && req.query.project) || "").trim();
  const token = String((req.query && req.query.token) || "").trim();
  return { projectId, token };
}

async function resolveAuthorizedProject(projectId, token) {
  if (!projectId || !token) return null;
  const project = await projectService.getProjectById(projectId);
  if (!project) return null;
  const valid = projectService.isProjectAccessValid(project, token);
  if (!valid) {
    console.log("ACCESS_TOKEN_EXPIRED", projectId);
    return null;
  }
  return project;
}

async function getProjectAreaDataController(req, res) {
  const { projectId, token } = parseAccessParams(req);
  const selectedPageId = String((req.query && req.query.selected) || "").trim();

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const payload = await projectAreaService.getProjectAreaData(project, selectedPageId || null);
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : "Could not load Project Area data."
    });
  }
}

async function sendProjectAreaPasswordResetController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.project || "").trim();
  const token = String(body.token || "").trim();

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const result = await projectAreaService.sendProjectAreaPasswordUpdateEmail(project);
    return res.json({
      ok: true,
      sentTo: result.email
    });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : "Could not send access link."
    });
  }
}

async function renameProjectAreaPageController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.project || "").trim();
  const token = String(body.token || "").trim();
  const pageId = String(body.pageId || "").trim();
  const title = String(body.title || "");
  const url = String(body.url || "").trim();

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const page = await projectAreaService.renameProjectAreaPage(project, pageId, title, url);
    return res.json({ ok: true, page });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : "Could not rename page."
    });
  }
}

async function createProjectAreaPageController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.project || "").trim();
  const token = String(body.token || "").trim();
  const parentId = String(body.parentId || "").trim();

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const result = await projectAreaService.createProjectAreaPage(project, parentId || null);
    return res.json({ ok: true, page: result.page, summary: result.summary });
  } catch (error) {
    return res.status(400).json({
      error: error && error.message ? error.message : "Could not create page."
    });
  }
}

async function deleteProjectAreaPageController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.project || "").trim();
  const token = String(body.token || "").trim();
  const pageId = String(body.pageId || "").trim();

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const result = await projectAreaService.deleteProjectAreaPage(project, pageId);
    return res.json({ ok: true, pages: result.pages, summary: result.summary });
  } catch (error) {
    return res.status(400).json({
      error: error && error.message ? error.message : "Could not delete page."
    });
  }
}

async function processProjectAreaPageController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.project || "").trim();
  const token = String(body.token || "").trim();
  const pageId = String(body.pageId || "").trim();
  const url = String(body.url || "").trim();

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const result = await projectAreaService.processProjectAreaPage(
      project,
      pageId || null,
      url || null
    );
    return res.json({
      ok: true,
      page: result.page,
      summary: result.summary,
      hasPending: Boolean(result.hasPending)
    });
  } catch (error) {
    return res.status(400).json({
      error: error && error.message ? error.message : "Could not process project page."
    });
  }
}

async function saveProjectAreaPageOrderController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.project || "").trim();
  const token = String(body.token || "").trim();
  const pages = Array.isArray(body.pages) ? body.pages : [];

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const savedPages = await projectAreaService.saveProjectAreaPageOrder(project, pages);
    return res.json({ ok: true, pages: savedPages });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : "Could not save page order."
    });
  }
}

async function publishProjectAreaController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.project || "").trim();
  const token = String(body.token || "").trim();

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const result = await projectPublishService.submitProjectForBuild(project);
    const projectArea = await projectAreaService.getProjectAreaData(result.project, null);
    return res.json({
      ok: true,
      projectArea,
      package: result.packageSummary,
      buildJob: result.buildJob ? {
        id: result.buildJob.id,
        status: result.buildJob.status,
        provider: result.buildJob.provider,
        target: result.buildJob.target
      } : null,
      reusedExistingPackage: Boolean(result.reusedExistingPackage)
    });
  } catch (error) {
    const statusCode = Number(error && error.statusCode ? error.statusCode : 500);
    return res.status(statusCode).json({
      error: error && error.message ? error.message : "Could not assemble the project package."
    });
  }
}

async function updateProjectAreaPasswordController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.project || "").trim();
  const token = String(body.token || "").trim();
  const password = String(body.password || "");

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const result = await projectAreaService.updateProjectAreaPassword(project, password);
    return res.json({ ok: true, email: result.email });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : "Could not update password."
    });
  }
}

async function requestAccessLinkController(req, res) {
  const body = req && req.body ? req.body : {};
  const email = String(body.email || "").trim();

  try {
    const result = await projectAreaService.requestProjectAreaAccessLink(email, getBaseUrl(req));
    return res.json({ ok: true, email: result.email });
  } catch (error) {
    return res.status(400).json({
      error: error && error.message ? error.message : "Could not send access link."
    });
  }
}

async function requestEmailUpdateController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.projectId || "").trim();
  const token = String(body.token || "").trim();
  const newEmail = String(body.newEmail || "").trim();

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const result = await projectAreaService.requestProjectAreaEmailUpdate(
      project,
      newEmail,
      getBaseUrl(req)
    );
    return res.json({ ok: true, email: result.email });
  } catch (error) {
    return res.status(400).json({
      error: error && error.message ? error.message : "Could not request email update."
    });
  }
}

async function verifyEmailUpdateController(req, res) {
  const token = String((req.query && req.query.token) || "").trim();

  try {
    const result = await projectAreaService.verifyProjectAreaEmailUpdate(token);
    const redirectUrl =
      `${getBaseUrl(req)}/project-area?project=${encodeURIComponent(result.projectId)}` +
      `&token=${encodeURIComponent(result.accessToken)}`;
    return res.redirect(302, redirectUrl);
  } catch (error) {
    return res.status(400).send(
      error && error.message ? error.message : "This email verification link is invalid or expired."
    );
  }
}

module.exports = {
  getProjectAreaDataController,
  createProjectAreaPageController,
  deleteProjectAreaPageController,
  processProjectAreaPageController,
  renameProjectAreaPageController,
  saveProjectAreaPageOrderController,
  publishProjectAreaController,
  updateProjectAreaPasswordController,
  sendProjectAreaPasswordResetController,
  requestAccessLinkController,
  requestEmailUpdateController,
  verifyEmailUpdateController
};
