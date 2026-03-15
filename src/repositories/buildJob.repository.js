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

function toBuildJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    quoteId: row.quote_id || null,
    packageKey: row.package_key,
    packageUrl: row.package_url || null,
    status: row.status || "queued",
    provider: row.provider || "openai",
    target: row.target || "static-html",
    retryCount: Number(row.retry_count || 0),
    buildStartedAt: row.build_started_at || null,
    buildCompletedAt: row.build_completed_at || null,
    buildOutputKey: row.build_output_key || null,
    buildOutputUrl: row.build_output_url || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function findBuildJobById(jobId) {
  if (!jobId) return null;
  await ensureSchema();
  const params = [String(jobId)];
  logQuery("findBuildJobById", params);

  const result = await query(
    `SELECT * FROM build_jobs
      WHERE id = $1
      LIMIT 1`,
    params
  );

  return toBuildJob(result.rows[0]);
}

async function findBuildJobByProjectId(projectId) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId)];
  logQuery("findBuildJobByProjectId", params);

  const result = await query(
    `SELECT * FROM build_jobs
      WHERE project_id = $1
      LIMIT 1`,
    params
  );

  return toBuildJob(result.rows[0]);
}

async function upsertBuildJob(input) {
  if (!input || !input.projectId || !input.packageKey) return null;
  await ensureSchema();

  const params = [
    input.id ? String(input.id) : generateId("job"),
    String(input.projectId),
    input.quoteId ? String(input.quoteId) : null,
    String(input.packageKey),
    input.packageUrl ? String(input.packageUrl) : null,
    String(input.status || "queued"),
    String(input.provider || "openai"),
    String(input.target || "static-html"),
    Number.isFinite(Number(input.retryCount)) ? Number(input.retryCount) : 0,
    input.buildStartedAt ? input.buildStartedAt : null,
    input.buildCompletedAt ? input.buildCompletedAt : null,
    input.buildOutputKey ? String(input.buildOutputKey) : null,
    input.buildOutputUrl ? String(input.buildOutputUrl) : null,
    input.errorMessage ? String(input.errorMessage) : null
  ];
  logQuery("upsertBuildJob", params);

  const result = await query(
    `INSERT INTO build_jobs (
      id, project_id, quote_id, package_key, package_url,
      status, provider, target, retry_count,
      build_started_at, build_completed_at, build_output_key, build_output_url, error_message,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13, $14,
      NOW(), NOW()
    )
    ON CONFLICT (project_id) DO UPDATE
      SET quote_id = EXCLUDED.quote_id,
          package_key = EXCLUDED.package_key,
          package_url = EXCLUDED.package_url,
          status = EXCLUDED.status,
          provider = EXCLUDED.provider,
          target = EXCLUDED.target,
          retry_count = EXCLUDED.retry_count,
          build_started_at = EXCLUDED.build_started_at,
          build_completed_at = EXCLUDED.build_completed_at,
          build_output_key = EXCLUDED.build_output_key,
          build_output_url = EXCLUDED.build_output_url,
          error_message = EXCLUDED.error_message,
          updated_at = NOW()
    RETURNING *`,
    params
  );

  return toBuildJob(result.rows[0]);
}

async function claimNextQueuedBuildJob() {
  await ensureSchema();
  logQuery("claimNextQueuedBuildJob", []);

  const result = await query(
    `WITH next_job AS (
      SELECT id
      FROM build_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE build_jobs AS jobs
      SET status = 'building',
          build_started_at = COALESCE(jobs.build_started_at, NOW()),
          build_completed_at = NULL,
          build_output_key = NULL,
          build_output_url = NULL,
          error_message = NULL,
          retry_count = CASE
            WHEN jobs.build_started_at IS NULL THEN jobs.retry_count
            ELSE jobs.retry_count + 1
          END,
          updated_at = NOW()
      FROM next_job
      WHERE jobs.id = next_job.id
      RETURNING jobs.*`
  );

  return toBuildJob(result.rows[0]);
}

async function markBuildJobFailed(jobId, errorMessage) {
  if (!jobId) return null;
  await ensureSchema();
  const params = [
    String(jobId),
    errorMessage ? String(errorMessage) : "The build worker encountered an unknown error."
  ];
  logQuery("markBuildJobFailed", params);

  const result = await query(
    `UPDATE build_jobs
      SET status = 'build_failed',
          build_completed_at = NOW(),
          error_message = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );

  return toBuildJob(result.rows[0]);
}

async function markBuildJobReadyForPublish(jobId, buildOutputKey, buildOutputUrl) {
  if (!jobId) return null;
  await ensureSchema();
  const params = [
    String(jobId),
    buildOutputKey ? String(buildOutputKey) : null,
    buildOutputUrl ? String(buildOutputUrl) : null
  ];
  logQuery("markBuildJobReadyForPublish", params);

  const result = await query(
    `UPDATE build_jobs
      SET status = 'build_ready_for_publish',
          build_completed_at = NOW(),
          build_output_key = $2,
          build_output_url = $3,
          error_message = NULL,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );

  return toBuildJob(result.rows[0]);
}

module.exports = {
  findBuildJobById,
  findBuildJobByProjectId,
  upsertBuildJob,
  claimNextQueuedBuildJob,
  markBuildJobFailed,
  markBuildJobReadyForPublish
};
