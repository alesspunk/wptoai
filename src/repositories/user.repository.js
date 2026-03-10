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

async function findUserByEmail(email) {
  if (!email) return null;
  await ensureSchema();
  const normalized = String(email).trim().toLowerCase();
  const result = await query(
    'SELECT * FROM users WHERE email = $1 LIMIT 1',
    [normalized]
  );
  return toUser(result.rows[0]);
}

async function findUserById(id) {
  if (!id) return null;
  await ensureSchema();
  const result = await query(
    "SELECT * FROM users WHERE id = $1 LIMIT 1",
    [String(id)]
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

  const result = await query(sql, [
    generateId('user'),
    normalized
  ]);

  return toUser(result.rows[0]);
}

module.exports = {
  findUserById,
  findUserByEmail,
  createUser
};
