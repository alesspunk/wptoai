const crypto = require('crypto');
const projectRepository = require('../repositories/project.repository');

function generateProjectAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

function computeAccessTokenExpiry() {
  return new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString();
}

async function createQueuedProject(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  if (!data.quoteId && !data.wordpressUrl) return null;

  const accessToken = generateProjectAccessToken();
  const accessTokenExpiresAt = computeAccessTokenExpiry();

  return projectRepository.createProject({
    quoteId: data.quoteId || null,
    userId: data.userId || null,
    customerEmail: data.customerEmail || null,
    wordpressUrl: data.wordpressUrl || null,
    status: 'queued',
    accessToken,
    accessTokenExpiresAt,
    vercelDeploymentUrl: data.vercelDeploymentUrl || null
  });
}

async function getProjectByQuoteId(quoteId) {
  return projectRepository.findProjectByQuoteId(quoteId);
}

async function getProjectById(projectId) {
  return projectRepository.findProjectById(projectId);
}

async function ensureProjectAccessToken(project) {
  if (!project || !project.id) return null;

  const expiresAt = project.accessTokenExpiresAt ? new Date(project.accessTokenExpiresAt).getTime() : 0;
  if (project.accessToken && expiresAt && expiresAt > Date.now()) {
    return project;
  }

  const accessToken = generateProjectAccessToken();
  const accessTokenExpiresAt = computeAccessTokenExpiry();
  return projectRepository.saveProjectAccessToken(project.id, accessToken, accessTokenExpiresAt);
}

function isProjectAccessValid(project, token) {
  if (!project || !token) return false;
  const expected = String(project.accessToken || '');
  if (!expected || expected !== String(token)) return false;

  const expiresAt = project.accessTokenExpiresAt ? new Date(project.accessTokenExpiresAt).getTime() : 0;
  if (!expiresAt) return false;
  return Date.now() <= expiresAt;
}

module.exports = {
  createQueuedProject,
  getProjectByQuoteId,
  getProjectById,
  ensureProjectAccessToken,
  isProjectAccessValid
};
