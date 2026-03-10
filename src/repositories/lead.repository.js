const crypto = require('crypto');
const { ensureSchema, query } = require('./postgres');

function generateId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    siteUrl: row.site_url,
    quoteId: row.quote_id,
    leadStatus: row.lead_status,
    createdAt: row.created_at
  };
}

async function createLead(input) {
  await ensureSchema();

  const sql = `
    INSERT INTO leads (id, email, site_url, quote_id, lead_status, created_at)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))
    RETURNING *
  `;

  const result = await query(sql, [
    input.id || generateId('lead'),
    input.email,
    input.siteUrl || null,
    input.quoteId || null,
    input.leadStatus || 'captured',
    input.createdAt || null
  ]);

  return toLead(result.rows[0]);
}

async function updateLeadStatusByQuoteId(quoteId, leadStatus) {
  if (!quoteId) return [];
  await ensureSchema();

  const result = await query(
    `UPDATE leads
       SET lead_status = $2
     WHERE quote_id = $1
     RETURNING *`,
    [quoteId, leadStatus]
  );

  return result.rows.map(toLead);
}

module.exports = {
  createLead,
  updateLeadStatusByQuoteId
};
