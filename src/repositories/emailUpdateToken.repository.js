const crypto = require("crypto");
const { ensureSchema, query } = require("./postgres");

function generateId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toEmailUpdateToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    newEmail: row.new_email,
    token: row.token,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

function logQuery(queryName, params) {
  console.log("SQL_QUERY_NAME", queryName);
  console.log("SQL_PARAMS", params);
}

async function createEmailUpdateToken(input) {
  await ensureSchema();

  const sql = `
    INSERT INTO email_update_tokens (
      id, project_id, new_email, token, expires_at, created_at
    )
    VALUES (
      $1, $2, $3, $4, $5, NOW()
    )
    RETURNING *
  `;
  const params = [
    input.id || generateId("email_update"),
    input.projectId || null,
    input.newEmail || null,
    input.token || null,
    input.expiresAt || null
  ];
  logQuery("createEmailUpdateToken", params);

  const result = await query(sql, params);
  return toEmailUpdateToken(result.rows[0]);
}

async function findEmailUpdateTokenByToken(token) {
  if (!token) return null;
  await ensureSchema();
  const params = [String(token)];
  logQuery("findEmailUpdateTokenByToken", params);

  const result = await query(
    "SELECT * FROM email_update_tokens WHERE token = $1 LIMIT 1",
    params
  );

  return toEmailUpdateToken(result.rows[0]);
}

async function deleteEmailUpdateTokenById(id) {
  if (!id) return false;
  await ensureSchema();
  const params = [String(id)];
  logQuery("deleteEmailUpdateTokenById", params);

  const result = await query(
    "DELETE FROM email_update_tokens WHERE id = $1",
    params
  );

  return result.rowCount > 0;
}

async function deleteEmailUpdateTokensByProjectId(projectId) {
  if (!projectId) return false;
  await ensureSchema();
  const params = [String(projectId)];
  logQuery("deleteEmailUpdateTokensByProjectId", params);

  const result = await query(
    "DELETE FROM email_update_tokens WHERE project_id = $1",
    params
  );

  return result.rowCount > 0;
}

module.exports = {
  createEmailUpdateToken,
  findEmailUpdateTokenByToken,
  deleteEmailUpdateTokenById,
  deleteEmailUpdateTokensByProjectId
};
