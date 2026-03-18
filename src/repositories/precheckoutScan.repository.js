const { ensureSchema, query } = require("./postgres");

function toPrecheckoutScan(row) {
  if (!row) return null;
  return {
    siteKey: row.site_key,
    siteUrl: row.site_url,
    scanStatus: row.scan_status || "pending",
    previewImageUrl: row.preview_image_url || null,
    detectedPages: Number(row.detected_pages || 0),
    detectedPagesData: Array.isArray(row.detected_pages_data) ? row.detected_pages_data : [],
    siteTitle: row.site_title || "",
    siteDescription: row.site_description || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function findPrecheckoutScanBySiteKey(siteKey) {
  if (!siteKey) return null;
  await ensureSchema();
  const result = await query(
    "SELECT * FROM precheckout_site_scans WHERE site_key = $1 LIMIT 1",
    [String(siteKey)]
  );
  return toPrecheckoutScan(result.rows[0]);
}

async function upsertPrecheckoutScan(input) {
  if (!input || !input.siteKey || !input.siteUrl) return null;
  await ensureSchema();

  const result = await query(
    `INSERT INTO precheckout_site_scans (
      site_key, site_url, scan_status, preview_image_url,
      detected_pages, detected_pages_data, site_title, site_description,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6::jsonb, $7, $8,
      NOW(), NOW()
    )
    ON CONFLICT (site_key) DO UPDATE
      SET site_url = EXCLUDED.site_url,
          scan_status = EXCLUDED.scan_status,
          preview_image_url = EXCLUDED.preview_image_url,
          detected_pages = EXCLUDED.detected_pages,
          detected_pages_data = EXCLUDED.detected_pages_data,
          site_title = EXCLUDED.site_title,
          site_description = EXCLUDED.site_description,
          updated_at = NOW()
    RETURNING *`,
    [
      String(input.siteKey),
      String(input.siteUrl),
      String(input.scanStatus || "pending"),
      input.previewImageUrl || null,
      Number.isFinite(Number(input.detectedPages)) ? Number(input.detectedPages) : null,
      JSON.stringify(Array.isArray(input.detectedPagesData) ? input.detectedPagesData : []),
      input.siteTitle || null,
      input.siteDescription || null
    ]
  );

  return toPrecheckoutScan(result.rows[0]);
}

module.exports = {
  findPrecheckoutScanBySiteKey,
  upsertPrecheckoutScan
};
