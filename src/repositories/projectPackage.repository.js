const { ensureSchema, query } = require("./postgres");

function toProjectPackage(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    quoteId: row.quote_id || null,
    packageVersion: row.package_version,
    schemaVersion: row.schema_version,
    status: row.status || "package_assembled",
    validationStatus: row.validation_status || "pending",
    validationErrors: Array.isArray(row.validation_errors_json) ? row.validation_errors_json : [],
    storageManifest: row.storage_manifest_json || {},
    packageKey: row.package_key || null,
    packageUrl: row.package_url || null,
    packageGeneratedAt: row.package_generated_at || null,
    sourceDomain: row.source_domain || null,
    approvedPageCount: Number(row.approved_page_count || 0),
    buildJobId: row.build_job_id || null,
    submittedAt: row.submitted_at || null,
    manifest: row.manifest_json || {},
    files: row.files_json || {},
    snapshot: row.snapshot_json || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function logQuery(queryName, params) {
  console.log("SQL_QUERY_NAME", queryName);
  console.log("SQL_PARAMS", params);
}

function buildPackageId(projectId) {
  return `pkg_${String(projectId || "").trim()}`;
}

async function findProjectPackageByProjectId(projectId) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId)];
  logQuery("findProjectPackageByProjectId", params);

  const result = await query(
    `SELECT * FROM project_packages
      WHERE project_id = $1
      LIMIT 1`,
    params
  );

  return toProjectPackage(result.rows[0]);
}

async function upsertProjectPackage(input) {
  if (!input || !input.projectId) return null;
  await ensureSchema();

  const params = [
    buildPackageId(input.projectId),
    String(input.projectId),
    input.quoteId ? String(input.quoteId) : null,
    String(input.packageVersion || ""),
    String(input.schemaVersion || ""),
    String(input.status || "package_assembled"),
    String(input.validationStatus || "pending"),
    JSON.stringify(Array.isArray(input.validationErrors) ? input.validationErrors : []),
    JSON.stringify(input.storageManifest || {}),
    input.packageKey ? String(input.packageKey) : null,
    input.packageUrl ? String(input.packageUrl) : null,
    input.packageGeneratedAt ? input.packageGeneratedAt : null,
    input.sourceDomain ? String(input.sourceDomain) : null,
    Number.isFinite(Number(input.approvedPageCount)) ? Number(input.approvedPageCount) : 0,
    input.buildJobId ? String(input.buildJobId) : null,
    input.submittedAt ? input.submittedAt : null,
    JSON.stringify(input.manifest || {}),
    JSON.stringify(input.files || {}),
    JSON.stringify(input.snapshot || {})
  ];
  logQuery("upsertProjectPackage", params);

  const result = await query(
    `INSERT INTO project_packages (
      id, project_id, quote_id, package_version, schema_version,
      status, validation_status, validation_errors_json, storage_manifest_json,
      package_key, package_url, package_generated_at, source_domain, approved_page_count,
      build_job_id, submitted_at, manifest_json, files_json, snapshot_json,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8::jsonb, $9::jsonb,
      $10, $11, $12, $13, $14,
      $15, $16, $17::jsonb, $18::jsonb, $19::jsonb,
      NOW(), NOW()
    )
    ON CONFLICT (project_id) DO UPDATE
      SET quote_id = EXCLUDED.quote_id,
          package_version = EXCLUDED.package_version,
          schema_version = EXCLUDED.schema_version,
          status = EXCLUDED.status,
          validation_status = EXCLUDED.validation_status,
          validation_errors_json = EXCLUDED.validation_errors_json,
          storage_manifest_json = EXCLUDED.storage_manifest_json,
          package_key = EXCLUDED.package_key,
          package_url = EXCLUDED.package_url,
          package_generated_at = EXCLUDED.package_generated_at,
          source_domain = EXCLUDED.source_domain,
          approved_page_count = EXCLUDED.approved_page_count,
          build_job_id = EXCLUDED.build_job_id,
          submitted_at = EXCLUDED.submitted_at,
          manifest_json = EXCLUDED.manifest_json,
          files_json = EXCLUDED.files_json,
          snapshot_json = EXCLUDED.snapshot_json,
          updated_at = NOW()
    RETURNING *`,
    params
  );

  return toProjectPackage(result.rows[0]);
}

module.exports = {
  findProjectPackageByProjectId,
  upsertProjectPackage
};
