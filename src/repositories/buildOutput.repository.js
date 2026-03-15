const crypto = require("crypto");
const { ensureSchema, query } = require("./postgres");

function generateId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function logQuery(queryName, params) {
  console.log("SQL_QUERY_NAME", queryName);
  console.log("SQL_PARAMS", params);
}

function toBuildOutput(row) {
  if (!row) return null;
  return {
    id: row.id,
    buildJobId: row.build_job_id,
    projectId: row.project_id,
    quoteId: row.quote_id || null,
    provider: row.provider || "openai",
    status: row.status || "building",
    outputKey: row.output_key || null,
    outputUrl: row.output_url || null,
    pageCountBuilt: Number(row.page_count_built || 0),
    files: row.files_json || {},
    buildLog: row.build_log_json || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function findBuildOutputByBuildJobId(buildJobId) {
  if (!buildJobId) return null;
  await ensureSchema();
  const params = [String(buildJobId)];
  logQuery("findBuildOutputByBuildJobId", params);

  const result = await query(
    `SELECT * FROM build_outputs
      WHERE build_job_id = $1
      LIMIT 1`,
    params
  );

  return toBuildOutput(result.rows[0]);
}

async function upsertBuildOutput(input) {
  if (!input || !input.buildJobId || !input.projectId) return null;
  await ensureSchema();

  const params = [
    input.id ? String(input.id) : generateId("build"),
    String(input.buildJobId),
    String(input.projectId),
    input.quoteId ? String(input.quoteId) : null,
    String(input.provider || "openai"),
    String(input.status || "building"),
    input.outputKey ? String(input.outputKey) : null,
    input.outputUrl ? String(input.outputUrl) : null,
    Number.isFinite(Number(input.pageCountBuilt)) ? Number(input.pageCountBuilt) : 0,
    JSON.stringify(input.files || {}),
    JSON.stringify(input.buildLog || {})
  ];
  logQuery("upsertBuildOutput", params);

  const result = await query(
    `INSERT INTO build_outputs (
      id, build_job_id, project_id, quote_id,
      provider, status, output_key, output_url, page_count_built,
      files_json, build_log_json, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8, $9,
      $10::jsonb, $11::jsonb, NOW(), NOW()
    )
    ON CONFLICT (build_job_id) DO UPDATE
      SET project_id = EXCLUDED.project_id,
          quote_id = EXCLUDED.quote_id,
          provider = EXCLUDED.provider,
          status = EXCLUDED.status,
          output_key = EXCLUDED.output_key,
          output_url = EXCLUDED.output_url,
          page_count_built = EXCLUDED.page_count_built,
          files_json = EXCLUDED.files_json,
          build_log_json = EXCLUDED.build_log_json,
          updated_at = NOW()
    RETURNING *`,
    params
  );

  return toBuildOutput(result.rows[0]);
}

module.exports = {
  findBuildOutputByBuildJobId,
  upsertBuildOutput
};
