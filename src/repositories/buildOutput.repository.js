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
    previewUrl: row.preview_url || null,
    deploymentId: row.deployment_id || null,
    repositoryUrl: row.repository_url || null,
    repositoryName: row.repository_name || null,
    vercelProjectId: row.vercel_project_id || null,
    packageVersion: row.package_version || null,
    publishedAt: row.published_at || null,
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
    input.previewUrl ? String(input.previewUrl) : null,
    input.deploymentId ? String(input.deploymentId) : null,
    input.repositoryUrl ? String(input.repositoryUrl) : null,
    input.repositoryName ? String(input.repositoryName) : null,
    input.vercelProjectId ? String(input.vercelProjectId) : null,
    input.packageVersion ? String(input.packageVersion) : null,
    input.publishedAt ? input.publishedAt : null,
    Number.isFinite(Number(input.pageCountBuilt)) ? Number(input.pageCountBuilt) : 0,
    JSON.stringify(input.files || {}),
    JSON.stringify(input.buildLog || {})
  ];
  logQuery("upsertBuildOutput", params);

  const result = await query(
    `INSERT INTO build_outputs (
      id, build_job_id, project_id, quote_id,
      provider, status, output_key, output_url,
      preview_url, deployment_id, repository_url, repository_name,
      vercel_project_id, package_version, published_at, page_count_built,
      files_json, build_log_json, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6, $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15, $16,
      $17::jsonb, $18::jsonb, NOW(), NOW()
    )
    ON CONFLICT (build_job_id) DO UPDATE
      SET project_id = EXCLUDED.project_id,
          quote_id = EXCLUDED.quote_id,
          provider = EXCLUDED.provider,
          status = EXCLUDED.status,
          output_key = EXCLUDED.output_key,
          output_url = EXCLUDED.output_url,
          preview_url = EXCLUDED.preview_url,
          deployment_id = EXCLUDED.deployment_id,
          repository_url = EXCLUDED.repository_url,
          repository_name = EXCLUDED.repository_name,
          vercel_project_id = EXCLUDED.vercel_project_id,
          package_version = EXCLUDED.package_version,
          published_at = EXCLUDED.published_at,
          page_count_built = EXCLUDED.page_count_built,
          files_json = EXCLUDED.files_json,
          build_log_json = EXCLUDED.build_log_json,
          updated_at = NOW()
    RETURNING *`,
    params
  );

  return toBuildOutput(result.rows[0]);
}

async function claimNextBuildOutputReadyForPublish() {
  await ensureSchema();
  logQuery("claimNextBuildOutputReadyForPublish", []);

  const result = await query(
    `WITH next_output AS (
      SELECT outputs.id
      FROM build_outputs AS outputs
      INNER JOIN build_jobs AS jobs
        ON jobs.id = outputs.build_job_id
      WHERE outputs.status = 'build_ready_for_publish'
        AND jobs.status = 'build_ready_for_publish'
      ORDER BY outputs.updated_at ASC, outputs.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE build_outputs AS outputs
      SET status = 'publishing_preview',
          updated_at = NOW()
      FROM next_output
      WHERE outputs.id = next_output.id
      RETURNING outputs.*`
  );

  return toBuildOutput(result.rows[0]);
}

module.exports = {
  findBuildOutputByBuildJobId,
  upsertBuildOutput,
  claimNextBuildOutputReadyForPublish
};
