const crypto = require('crypto');
const { ensureSchema, query } = require('./postgres');

function generateId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function logQuery(queryName, params) {
  console.log('SQL_QUERY_NAME', queryName);
  console.log('SQL_PARAMS', params);
}

async function findUserByEmail(email) {
  if (!email) return null;
  await ensureSchema();
  const normalized = String(email).trim().toLowerCase();
  const params = [normalized];
  logQuery('findUserByEmail', params);
  const result = await query(
    'SELECT * FROM users WHERE email = $1 LIMIT 1',
    params
  );
  return toUser(result.rows[0]);
}

async function findUserById(id) {
  if (!id) return null;
  await ensureSchema();
  const params = [String(id)];
  logQuery('findUserById', params);
  const result = await query(
    "SELECT * FROM users WHERE id = $1 LIMIT 1",
    params
  );
  return toUser(result.rows[0]);
}

async function createUser(email) {
  await ensureSchema();
  const normalized = String(email || '').trim().toLowerCase();

  const sql = `
    INSERT INTO users (id, email, password_hash, created_at, updated_at)
    VALUES ($1, $2, NULL, NOW(), NOW())
    ON CONFLICT (email)
    DO UPDATE SET updated_at = NOW()
    RETURNING *
  `;
  const params = [
    generateId('user'),
    normalized
  ];
  logQuery('createUser', params);

  const result = await query(sql, params);

  return toUser(result.rows[0]);
}

async function updateUserPasswordHash(userId, passwordHash) {
  if (!userId || !passwordHash) return null;
  await ensureSchema();
  const params = [String(userId), String(passwordHash)];
  logQuery('updateUserPasswordHash', params);
  const result = await query(
    `UPDATE users
      SET password_hash = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );
  return toUser(result.rows[0]);
}

async function updateUserEmail(userId, email) {
  if (!userId || !email) return null;
  await ensureSchema();
  const params = [String(userId), String(email).trim().toLowerCase()];
  logQuery("updateUserEmail", params);
  const result = await query(
    `UPDATE users
      SET email = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );
  return toUser(result.rows[0]);
}

module.exports = {
  findUserById,
  findUserByEmail,
  createUser,
  updateUserPasswordHash,
  updateUserEmail
};
