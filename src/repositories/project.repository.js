const crypto = require('crypto');
const { ensureSchema, query } = require('./postgres');
const PROJECT_QUEUE_LOCK_STALE_MINUTES = 15;

function generateId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    quoteId: row.quote_id,
    userId: row.user_id || null,
    customerEmail: row.customer_email,
    wordpressUrl: row.wordpress_url,
    status: row.status,
    publishStatus: row.publish_status || 'ready_to_publish',
    frozenAt: row.frozen_at || null,
    publishStartedAt: row.publish_started_at || null,
    packageAssembledAt: row.package_assembled_at || null,
    submittedAt: row.submitted_at || null,
    packageVersion: row.package_version || null,
    packageSchemaVersion: row.package_schema_version || null,
    buildJobId: row.build_job_id || null,
    accessToken: row.access_token || null,
    accessTokenExpiresAt: row.access_token_expires_at || null,
    vercelDeploymentUrl: row.vercel_deployment_url,
    queueStatus: row.queue_status || 'idle',
    queueLockedAt: row.queue_locked_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function logQuery(queryName, params) {
  console.log('SQL_QUERY_NAME', queryName);
  console.log('SQL_PARAMS', params);
}

async function createProject(input) {
  await ensureSchema();

  const sql = `
    INSERT INTO projects (
      id, quote_id, user_id, customer_email, wordpress_url,
      status, access_token, access_token_expires_at,
      vercel_deployment_url, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, COALESCE($10, NOW()), COALESCE($11, NOW())
    )
    RETURNING *
  `;

  const params = [
    input.id || generateId('proj'),
    input.quoteId ?? null,
    input.userId ?? null,
    input.customerEmail ?? null,
    input.wordpressUrl ?? null,
    input.status || 'queued',
    input.accessToken ?? null,
    input.accessTokenExpiresAt ?? null,
    input.vercelDeploymentUrl ?? null,
    input.createdAt ?? null,
    input.updatedAt ?? null
  ];
  logQuery('createProject', params);

  const result = await query(sql, params);

  return toProject(result.rows[0]);
}

async function saveProjectAccessToken(projectId, accessToken, accessTokenExpiresAt) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId), accessToken ?? null, accessTokenExpiresAt ?? null];
  logQuery('saveProjectAccessToken', params);

  const result = await query(
    `UPDATE projects
        SET access_token = $2,
            access_token_expires_at = $3,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );

  return toProject(result.rows[0]);
}

async function findProjectByQuoteId(quoteId) {
  if (!quoteId) return null;
  await ensureSchema();
  const params = [String(quoteId)];
  logQuery('findProjectByQuoteId', params);

  const result = await query(
    `SELECT * FROM projects
      WHERE quote_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );

  return toProject(result.rows[0]);
}

async function findProjectById(projectId) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId)];
  logQuery('findProjectById', params);

  const result = await query(
    'SELECT * FROM projects WHERE id = $1 LIMIT 1',
    params
  );

  return toProject(result.rows[0]);
}

async function findLatestProjectByUserId(userId) {
  if (!userId) return null;
  await ensureSchema();
  const params = [String(userId)];
  logQuery('findLatestProjectByUserId', params);

  const result = await query(
    `SELECT * FROM projects
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );

  return toProject(result.rows[0]);
}

async function findLatestProjectByCustomerEmail(email) {
  if (!email) return null;
  await ensureSchema();
  const params = [String(email).trim().toLowerCase()];
  logQuery('findLatestProjectByCustomerEmail', params);

  const result = await query(
    `SELECT * FROM projects
      WHERE customer_email = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    params
  );

  return toProject(result.rows[0]);
}

async function updateProjectCustomerEmail(projectId, customerEmail) {
  if (!projectId || !customerEmail) return null;
  await ensureSchema();
  const params = [String(projectId), String(customerEmail).trim().toLowerCase()];
  logQuery("updateProjectCustomerEmail", params);

  const result = await query(
    `UPDATE projects
      SET customer_email = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );

  return toProject(result.rows[0]);
}

async function tryAcquireProjectQueue(projectId) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId), PROJECT_QUEUE_LOCK_STALE_MINUTES];
  logQuery('tryAcquireProjectQueue', params);

  const result = await query(
    `UPDATE projects
        SET queue_status = 'processing',
            queue_locked_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND (
          COALESCE(queue_status, 'idle') <> 'processing'
          OR queue_locked_at IS NULL
          OR queue_locked_at < NOW() - ($2::int * INTERVAL '1 minute')
        )
      RETURNING *`,
    params
  );

  return toProject(result.rows[0]);
}

async function touchProjectQueue(projectId) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId)];
  logQuery('touchProjectQueue', params);

  const result = await query(
    `UPDATE projects
        SET queue_locked_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND COALESCE(queue_status, 'idle') = 'processing'
      RETURNING *`,
    params
  );

  return toProject(result.rows[0]);
}

async function releaseProjectQueue(projectId) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId)];
  logQuery('releaseProjectQueue', params);

  const result = await query(
    `UPDATE projects
        SET queue_status = 'idle',
            queue_locked_at = NULL,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );

  return toProject(result.rows[0]);
}

async function updateProjectStatus(projectId, status) {
  if (!projectId || !status) return null;
  await ensureSchema();
  const params = [String(projectId), String(status)];
  logQuery('updateProjectStatus', params);

  const result = await query(
    `UPDATE projects
        SET status = $2,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );

  return toProject(result.rows[0]);
}

async function updateProjectPublishState(projectId, patch) {
  if (!projectId) return null;
  await ensureSchema();

  const params = [
    String(projectId),
    patch && patch.publishStatus ? String(patch.publishStatus) : null,
    Boolean(patch && patch.freezeProject),
    Boolean(patch && patch.touchPublishStartedAt),
    patch && patch.packageAssembledAt ? patch.packageAssembledAt : null,
    patch && patch.packageVersion ? String(patch.packageVersion) : null,
    patch && patch.packageSchemaVersion ? String(patch.packageSchemaVersion) : null,
    patch && patch.submittedAt ? patch.submittedAt : null,
    patch && patch.buildJobId ? String(patch.buildJobId) : null
  ];
  logQuery('updateProjectPublishState', params);

  const result = await query(
    `UPDATE projects
        SET publish_status = COALESCE($2, publish_status),
            frozen_at = CASE WHEN $3::boolean THEN COALESCE(frozen_at, NOW()) ELSE frozen_at END,
            publish_started_at = CASE WHEN $4::boolean THEN COALESCE(publish_started_at, NOW()) ELSE publish_started_at END,
            package_assembled_at = COALESCE($5, package_assembled_at),
            package_version = COALESCE($6, package_version),
            package_schema_version = COALESCE($7, package_schema_version),
            submitted_at = COALESCE($8, submitted_at),
            build_job_id = COALESCE($9, build_job_id),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    params
  );

  return toProject(result.rows[0]);
}

async function markProjectPublishing(projectId, packageVersion, packageSchemaVersion) {
  return updateProjectPublishState(projectId, {
    publishStatus: 'publishing',
    freezeProject: true,
    touchPublishStartedAt: true,
    packageVersion,
    packageSchemaVersion
  });
}

async function markProjectPackageAssembled(projectId, packageVersion, packageSchemaVersion, packageAssembledAt) {
  return updateProjectPublishState(projectId, {
    publishStatus: 'package_assembled',
    freezeProject: true,
    touchPublishStartedAt: true,
    packageAssembledAt: packageAssembledAt || new Date().toISOString(),
    packageVersion,
    packageSchemaVersion
  });
}

async function markProjectPublishFailed(projectId, packageVersion, packageSchemaVersion) {
  return updateProjectPublishState(projectId, {
    publishStatus: 'publish_failed',
    freezeProject: true,
    touchPublishStartedAt: true,
    packageVersion,
    packageSchemaVersion
  });
}

async function markProjectValidationFailed(projectId, packageVersion, packageSchemaVersion) {
  return updateProjectPublishState(projectId, {
    publishStatus: 'failed_validation',
    freezeProject: true,
    touchPublishStartedAt: true,
    packageVersion,
    packageSchemaVersion
  });
}

async function markProjectSubmitted(projectId, buildJobId, packageVersion, packageSchemaVersion, packageAssembledAt, submittedAt) {
  return updateProjectPublishState(projectId, {
    publishStatus: 'submitted',
    freezeProject: true,
    touchPublishStartedAt: true,
    packageAssembledAt: packageAssembledAt || new Date().toISOString(),
    packageVersion,
    packageSchemaVersion,
    submittedAt: submittedAt || new Date().toISOString(),
    buildJobId
  });
}

async function markProjectBuildInProgress(projectId, buildJobId, packageVersion, packageSchemaVersion) {
  const project = await updateProjectStatus(projectId, 'building');
  if (!project) return null;
  return updateProjectPublishState(projectId, {
    publishStatus: 'submitted',
    freezeProject: true,
    touchPublishStartedAt: true,
    packageVersion,
    packageSchemaVersion,
    buildJobId
  });
}

async function markProjectBuildReadyForPublish(projectId, buildJobId, packageVersion, packageSchemaVersion) {
  const project = await updateProjectStatus(projectId, 'building');
  if (!project) return null;
  return updateProjectPublishState(projectId, {
    publishStatus: 'submitted',
    freezeProject: true,
    touchPublishStartedAt: true,
    packageVersion,
    packageSchemaVersion,
    buildJobId
  });
}

async function markProjectBuildFailed(projectId, buildJobId, packageVersion, packageSchemaVersion) {
  const project = await updateProjectStatus(projectId, 'failed');
  if (!project) return null;
  return updateProjectPublishState(projectId, {
    publishStatus: 'build_failed',
    freezeProject: true,
    touchPublishStartedAt: true,
    packageVersion,
    packageSchemaVersion,
    buildJobId
  });
}

module.exports = {
  createProject,
  saveProjectAccessToken,
  findProjectByQuoteId,
  findProjectById,
  findLatestProjectByUserId,
  findLatestProjectByCustomerEmail,
  updateProjectCustomerEmail,
  tryAcquireProjectQueue,
  touchProjectQueue,
  releaseProjectQueue,
  updateProjectStatus,
  updateProjectPublishState,
  markProjectPublishing,
  markProjectPackageAssembled,
  markProjectPublishFailed,
  markProjectValidationFailed,
  markProjectSubmitted,
  markProjectBuildInProgress,
  markProjectBuildReadyForPublish,
  markProjectBuildFailed
};
