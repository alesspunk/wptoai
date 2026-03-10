const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;
let schemaReadyPromise = null;

function shouldUseSsl() {
  if (process.env.DATABASE_SSL === 'true') return true;
  if (process.env.DATABASE_SSL === 'false') return false;
  return Boolean(process.env.VERCEL);
}

function getPool() {
  if (pool) return pool;

  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured.');
  }

  pool = new Pool({
    connectionString,
    max: 5,
    ssl: shouldUseSsl() ? { rejectUnauthorized: false } : false
  });

  return pool;
}

async function query(text, params) {
  const clientPool = getPool();
  return clientPool.query(text, params);
}

async function ensureSchema() {
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    const schemaPath = path.join(__dirname, '..', 'models', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await query(schemaSql);
  })();

  try {
    await schemaReadyPromise;
  } catch (error) {
    schemaReadyPromise = null;
    throw error;
  }
}

module.exports = {
  query,
  ensureSchema
};
