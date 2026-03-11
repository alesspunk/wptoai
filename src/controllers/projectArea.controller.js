const projectService = require("../services/project.service");
const projectAreaService = require("../services/projectArea.service");

const EXPIRED_MESSAGE = "Session expired. Please check your email for your project access link.";

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
  if (!valid) return null;
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
      error: error && error.message ? error.message : "Could not send password update email."
    });
  }
}

async function renameProjectAreaPageController(req, res) {
  const body = req && req.body ? req.body : {};
  const projectId = String(body.project || "").trim();
  const token = String(body.token || "").trim();
  const pageId = String(body.pageId || "").trim();
  const title = String(body.title || "");

  try {
    const project = await resolveAuthorizedProject(projectId, token);
    if (!project) {
      return res.status(401).json({ error: EXPIRED_MESSAGE });
    }

    const page = await projectAreaService.renameProjectAreaPage(project, pageId, title);
    return res.json({ ok: true, page });
  } catch (error) {
    return res.status(500).json({
      error: error && error.message ? error.message : "Could not rename page."
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

module.exports = {
  getProjectAreaDataController,
  renameProjectAreaPageController,
  saveProjectAreaPageOrderController,
  sendProjectAreaPasswordResetController
};
