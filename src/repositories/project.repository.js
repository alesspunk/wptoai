const crypto = require('crypto');
const { ensureSchema, query } = require('./postgres');

function generateId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    quoteId: row.quote_id,
    userId: row.user_id || null,
    customerEmail: row.customer_email,
    wordpressUrl: row.wordpress_url,
    status: row.status,
    accessToken: row.access_token || null,
    accessTokenExpiresAt: row.access_token_expires_at || null,
    vercelDeploymentUrl: row.vercel_deployment_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function logQuery(queryName, params) {
  console.log('SQL_QUERY_NAME', queryName);
  console.log('SQL_PARAMS', params);
}

async function createProject(input) {
  await ensureSchema();

  const sql = `
    INSERT INTO projects (
      id, quote_id, user_id, customer_email, wordpress_url,
      status, access_token, access_token_expires_at,
      vercel_deployment_url, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, COALESCE($10, NOW()), COALESCE($11, NOW())
    )
    RETURNING *
  `;

  const params = [
    input.id || generateId('proj'),
    input.quoteId ?? null,
    input.userId ?? null,
    input.customerEmail ?? null,
    input.wordpressUrl ?? null,
    input.status || 'queued',
    input.accessToken ?? null,
    input.accessTokenExpiresAt ?? null,
    input.vercelDeploymentUrl ?? null,
    input.createdAt ?? null,
    input.updatedAt ?? null
  ];
  logQuery('createProject', params);

  const result = await query(sql, params);

  return toProject(result.rows[0]);
}

async function saveProjectAccessToken(projectId, accessToken, accessTokenExpiresAt) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId), accessToken ?? null, accessTokenExpiresAt ?? null];
  logQuery('saveProjectAccessToken', params);

  const result = await query(
    `UPDATE projects
        SET access_token = $2,
            access_token_expires_at = $3,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );

  return toProject(result.rows[0]);
}

async function findProjectByQuoteId(quoteId) {
  if (!quoteId) return null;
  await ensureSchema();
  const params = [String(quoteId)];
  logQuery('findProjectByQuoteId', params);

  const result = await query(
    `SELECT * FROM projects
      WHERE quote_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );

  return toProject(result.rows[0]);
}

async function findProjectById(projectId) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId)];
  logQuery('findProjectById', params);

  const result = await query(
    'SELECT * FROM projects WHERE id = $1 LIMIT 1',
    params
  );

  return toProject(result.rows[0]);
}

async function findLatestProjectByUserId(userId) {
  if (!userId) return null;
  await ensureSchema();
  const params = [String(userId)];
  logQuery('findLatestProjectByUserId', params);

  const result = await query(
    `SELECT * FROM projects
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );

  return toProject(result.rows[0]);
}

async function findLatestProjectByCustomerEmail(email) {
  if (!email) return null;
  await ensureSchema();
  const params = [String(email).trim().toLowerCase()];
  logQuery('findLatestProjectByCustomerEmail', params);

  const result = await query(
    `SELECT * FROM projects
      WHERE customer_email = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );

  return toProject(result.rows[0]);
}

async function updateProjectCustomerEmail(projectId, customerEmail) {
  if (!projectId || !customerEmail) return null;
  await ensureSchema();
  const params = [String(projectId), String(customerEmail).trim().toLowerCase()];
  logQuery("updateProjectCustomerEmail", params);

  const result = await query(
    `UPDATE projects
      SET customer_email = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );

  return toProject(result.rows[0]);
}

module.exports = {
  createProject,
  saveProjectAccessToken,
  findProjectByQuoteId,
  findProjectById,
  findLatestProjectByUserId,
  findLatestProjectByCustomerEmail,
  updateProjectCustomerEmail
};
