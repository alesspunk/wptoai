const crypto = require('crypto');
const { ensureSchema, query } = require('./postgres');

function generateId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toQuote(row) {
  if (!row) return null;
  return {
    id: row.id,
    siteUrl: row.site_url,
    email: row.email || '',
    plan: row.plan || {},
    addons: Array.isArray(row.addons_json) ? row.addons_json : [],
    setupFee: Number(row.setup_fee || 0),
    monthlyFee: Number(row.monthly_fee || 0),
    currency: row.currency || 'usd',
    status: row.status,
    scanStatus: row.scan_status,
    previewImageUrl: row.preview_image_url,
    detectedPages: Number(row.detected_pages || 0),
    siteTitle: row.site_title || '',
    siteDescription: row.site_description || '',
    stripeSessionId: row.stripe_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createQuote(input) {
  await ensureSchema();
  const id = input.id || generateId('quote');

  const sql = `
    INSERT INTO quotes (
      id, site_url, email, plan, addons_json,
      setup_fee, monthly_fee, currency, status,
      scan_status, preview_image_url, detected_pages,
      site_title, site_description, stripe_session_id,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4::jsonb, $5::jsonb,
      $6, $7, $8, $9,
      $10, $11, $12,
      $13, $14, $15,
      COALESCE($16, NOW()), COALESCE($17, NOW())
    )
    RETURNING *
  `;

  const values = [
    id,
    input.siteUrl,
    input.email || null,
    JSON.stringify(input.plan || {}),
    JSON.stringify(Array.isArray(input.addons) ? input.addons : []),
    Number(input.setupFee || 0),
    Number(input.monthlyFee || 0),
    input.currency || 'usd',
    input.status || 'draft',
    input.scanStatus || 'pending',
    input.previewImageUrl || null,
    Number.isFinite(input.detectedPages) ? input.detectedPages : null,
    input.siteTitle || null,
    input.siteDescription || null,
    input.stripeSessionId || null,
    input.createdAt || null,
    input.updatedAt || null
  ];

  const result = await query(sql, values);
  return toQuote(result.rows[0]);
}

async function findQuoteById(id) {
  if (!id) return null;
  await ensureSchema();
  const result = await query('SELECT * FROM quotes WHERE id = $1 LIMIT 1', [id]);
  return toQuote(result.rows[0]);
}

async function findQuoteByStripeSessionId(stripeSessionId) {
  if (!stripeSessionId) return null;
  await ensureSchema();
  const result = await query('SELECT * FROM quotes WHERE stripe_session_id = $1 LIMIT 1', [stripeSessionId]);
  return toQuote(result.rows[0]);
}

async function findLatestQuoteBySiteUrl(siteUrl) {
  if (!siteUrl) return null;
  await ensureSchema();
  const result = await query(
    'SELECT * FROM quotes WHERE site_url = $1 ORDER BY created_at DESC LIMIT 1',
    [siteUrl]
  );
  return toQuote(result.rows[0]);
}

async function updateQuoteScan(quoteId, scanPatch) {
  if (!quoteId) return null;
  await ensureSchema();

  const sql = `
    UPDATE quotes
    SET
      scan_status = COALESCE($2, scan_status),
      preview_image_url = COALESCE($3, preview_image_url),
      detected_pages = COALESCE($4, detected_pages),
      site_title = COALESCE($5, site_title),
      site_description = COALESCE($6, site_description),
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `;

  const result = await query(sql, [
    quoteId,
    scanPatch && scanPatch.scanStatus ? scanPatch.scanStatus : null,
    scanPatch && scanPatch.previewImageUrl ? scanPatch.previewImageUrl : null,
    scanPatch && Number.isFinite(scanPatch.detectedPages) ? scanPatch.detectedPages : null,
    scanPatch && scanPatch.siteTitle ? scanPatch.siteTitle : null,
    scanPatch && scanPatch.siteDescription ? scanPatch.siteDescription : null
  ]);

  return toQuote(result.rows[0]);
}

async function updateQuoteStatus(quoteId, patch) {
  if (!quoteId) return null;
  await ensureSchema();

  const sql = `
    UPDATE quotes
    SET
      status = COALESCE($2, status),
      stripe_session_id = COALESCE($3, stripe_session_id),
      email = COALESCE($4, email),
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `;

  const result = await query(sql, [
    quoteId,
    patch && patch.status ? patch.status : null,
    patch && patch.stripeSessionId ? patch.stripeSessionId : null,
    patch && patch.email ? patch.email : null
  ]);

  return toQuote(result.rows[0]);
}

module.exports = {
  createQuote,
  findQuoteById,
  findQuoteByStripeSessionId,
  findLatestQuoteBySiteUrl,
  updateQuoteScan,
  updateQuoteStatus
};
