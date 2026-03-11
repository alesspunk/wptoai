const crypto = require("crypto");
const { ensureSchema, query } = require("./postgres");

function generateId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toProjectPage(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    url: row.url || "",
    type: row.type,
    parentId: row.parent_id || null,
    status: row.status,
    screenshotUrl: row.screenshot_url || "",
    orderIndex: Number(row.order_index || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function logQuery(queryName, params) {
  console.log("SQL_QUERY_NAME", queryName);
  console.log("SQL_PARAMS", params);
}

async function findProjectPagesByProjectId(projectId) {
  if (!projectId) return [];
  await ensureSchema();
  const params = [String(projectId)];
  logQuery("findProjectPagesByProjectId", params);
  const result = await query(
    `SELECT * FROM project_pages
      WHERE project_id = $1
      ORDER BY order_index ASC, created_at ASC`,
    params
  );
  return result.rows.map(toProjectPage);
}

async function findProjectPageById(projectId, pageId) {
  if (!projectId || !pageId) return null;
  await ensureSchema();
  const params = [String(projectId), String(pageId)];
  logQuery("findProjectPageById", params);
  const result = await query(
    `SELECT * FROM project_pages
      WHERE project_id = $1 AND id = $2
      LIMIT 1`,
    params
  );
  return toProjectPage(result.rows[0]);
}

async function seedProjectPagesIfEmpty(projectId, pages) {
  if (!projectId || !Array.isArray(pages) || pages.length === 0) {
    return [];
  }
  await ensureSchema();

  const countParams = [String(projectId)];
  logQuery("seedProjectPagesIfEmpty.countProjectPages", countParams);
  const countResult = await query(
    "SELECT COUNT(*)::int AS total FROM project_pages WHERE project_id = $1",
    countParams
  );
  const total = countResult.rows[0] ? Number(countResult.rows[0].total || 0) : 0;
  if (total > 0) {
    return findProjectPagesByProjectId(projectId);
  }

  const values = [];
  const placeholders = [];
  pages.forEach((page, index) => {
    const offset = index * 9;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, NOW(), NOW())`
    );
    values.push(
      page.id || generateId("pg"),
      String(projectId),
      page.title || "Untitled",
      page.url ?? null,
      page.type || "page",
      page.parentId ?? null,
      page.status || "queued",
      page.screenshotUrl ?? null,
      Number.isFinite(page.orderIndex) ? page.orderIndex : index
    );
  });

  logQuery("seedProjectPagesIfEmpty.insertProjectPages", values);
  console.log("PROJECT_AREA_QUERY_FIXED", "seedProjectPagesIfEmpty.insertProjectPages");
  await query(
    `INSERT INTO project_pages (
      id, project_id, title, url, type, parent_id, status, screenshot_url, order_index, created_at, updated_at
    ) VALUES ${placeholders.join(", ")}`,
    values
  );

  return findProjectPagesByProjectId(projectId);
}

async function updateProjectPageTitle(projectId, pageId, title, url) {
  if (!projectId || !pageId) return null;
  await ensureSchema();
  const params = [
    String(projectId),
    String(pageId),
    String(title || "").trim(),
    String(url || "").trim() || null
  ];
  logQuery("updateProjectPageTitle", params);
  const result = await query(
    `UPDATE project_pages
      SET title = $3,
          url = COALESCE($4, url),
          updated_at = NOW()
      WHERE project_id = $1 AND id = $2
      RETURNING *`,
    params
  );
  return toProjectPage(result.rows[0]);
}

async function createProjectPage(projectId, input) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [
    input && input.id ? String(input.id) : generateId("pg"),
    String(projectId),
    input && input.title ? String(input.title).trim() : "Untitled Page",
    input && input.url ? String(input.url).trim() : null,
    input && input.type ? String(input.type).trim() : "page",
    input && input.parentId ? String(input.parentId).trim() : null,
    input && input.status ? String(input.status).trim() : "queued",
    input && input.screenshotUrl ? String(input.screenshotUrl).trim() : null,
    Number.isFinite(Number(input && input.orderIndex)) ? Number(input.orderIndex) : 0
  ];
  logQuery("createProjectPage", params);
  const result = await query(
    `INSERT INTO project_pages (
      id, project_id, title, url, type, parent_id, status, screenshot_url, order_index, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()
    )
    RETURNING *`,
    params
  );
  return toProjectPage(result.rows[0]);
}

async function updateProjectPageStatus(projectId, pageId, status) {
  if (!projectId || !pageId || !status) return null;
  await ensureSchema();
  const params = [String(projectId), String(pageId), String(status)];
  logQuery("updateProjectPageStatus", params);
  const result = await query(
    `UPDATE project_pages
      SET status = $3,
          updated_at = NOW()
      WHERE project_id = $1 AND id = $2
      RETURNING *`,
    params
  );
  return toProjectPage(result.rows[0]);
}

async function updateProjectPageScanResult(projectId, pageId, patch) {
  if (!projectId || !pageId) return null;
  await ensureSchema();
  const params = [
    String(projectId),
    String(pageId),
    patch && patch.title ? String(patch.title).trim() : null,
    patch && patch.url ? String(patch.url).trim() : null,
    patch && patch.status ? String(patch.status).trim() : null,
    patch && patch.screenshotUrl ? String(patch.screenshotUrl).trim() : null
  ];
  logQuery("updateProjectPageScanResult", params);
  const result = await query(
    `UPDATE project_pages
      SET title = COALESCE($3, title),
          url = COALESCE($4, url),
          status = COALESCE($5, status),
          screenshot_url = COALESCE($6, screenshot_url),
          updated_at = NOW()
      WHERE project_id = $1 AND id = $2
      RETURNING *`,
    params
  );
  return toProjectPage(result.rows[0]);
}

async function getNextQueuedProjectPage(projectId) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId)];
  logQuery("getNextQueuedProjectPage", params);
  const result = await query(
    `SELECT * FROM project_pages
      WHERE project_id = $1
        AND type IN ('homepage', 'page')
        AND COALESCE(url, '') <> ''
        AND status IN ('queued', 'processing')
        AND NOT (status = 'ready' AND COALESCE(screenshot_url, '') <> '')
      ORDER BY CASE WHEN type = 'homepage' THEN 0 ELSE 1 END, order_index ASC, created_at ASC
      LIMIT 1`,
    params
  );
  return toProjectPage(result.rows[0]);
}

async function claimNextQueuedProjectPage(projectId) {
  if (!projectId) return null;
  await ensureSchema();
  const params = [String(projectId)];
  logQuery("claimNextQueuedProjectPage", params);
  const result = await query(
    `WITH next_page AS (
      SELECT id
      FROM project_pages
      WHERE project_id = $1
        AND type IN ('homepage', 'page')
        AND COALESCE(url, '') <> ''
        AND status IN ('queued', 'processing')
        AND NOT (status = 'ready' AND COALESCE(screenshot_url, '') <> '')
      ORDER BY CASE WHEN type = 'homepage' THEN 0 ELSE 1 END, order_index ASC, created_at ASC
      LIMIT 1
    )
    UPDATE project_pages
      SET status = 'processing',
          updated_at = NOW()
    WHERE project_id = $1
      AND id IN (SELECT id FROM next_page)
    RETURNING *`,
    params
  );
  return toProjectPage(result.rows[0]);
}

async function clearProjectPageScreenshot(projectId, pageId) {
  if (!projectId || !pageId) return null;
  await ensureSchema();
  const params = [String(projectId), String(pageId)];
  logQuery("clearProjectPageScreenshot", params);
  const result = await query(
    `UPDATE project_pages
      SET screenshot_url = NULL,
          updated_at = NOW()
      WHERE project_id = $1 AND id = $2
      RETURNING *`,
    params
  );
  return toProjectPage(result.rows[0]);
}

async function deleteProjectPagesByIds(projectId, pageIds) {
  if (!projectId || !Array.isArray(pageIds) || !pageIds.length) {
    return 0;
  }
  await ensureSchema();

  const normalizedIds = pageIds
    .map(function (pageId) {
      return String(pageId || "").trim();
    })
    .filter(Boolean);

  if (!normalizedIds.length) {
    return 0;
  }

  const params = [String(projectId), normalizedIds];
  logQuery("deleteProjectPagesByIds", params);
  const result = await query(
    `DELETE FROM project_pages
      WHERE project_id = $1
        AND id = ANY($2::text[])`,
    params
  );
  return Number(result.rowCount || 0);
}

async function updateProjectPageOrder(projectId, updates) {
  if (!projectId || !Array.isArray(updates) || !updates.length) {
    return [];
  }
  await ensureSchema();

  const normalizedUpdates = updates
    .map(function (item, index) {
      return {
        id: String(item && item.id ? item.id : "").trim(),
        parentId: item && item.parentId ? String(item.parentId) : null,
        type: String(item && item.type ? item.type : "page").trim() || "page",
        orderIndex: Number.isFinite(Number(item && item.orderIndex)) ? Number(item.orderIndex) : index
      };
    })
    .filter(function (item) {
      return Boolean(item.id);
    });

  if (!normalizedUpdates.length) {
    return [];
  }

  const values = [String(projectId)];
  const ids = [];
  const parentCases = [];
  const typeCases = [];
  const orderCases = [];

  normalizedUpdates.forEach(function (item) {
    values.push(item.id);
    var idParam = values.length;
    values.push(item.parentId);
    var parentParam = values.length;
    values.push(item.type);
    var typeParam = values.length;
    values.push(item.orderIndex);
    var orderParam = values.length;

    ids.push("$" + idParam);
    parentCases.push("WHEN id = $" + idParam + " THEN $" + parentParam + "::text");
    typeCases.push("WHEN id = $" + idParam + " THEN $" + typeParam + "::text");
    orderCases.push("WHEN id = $" + idParam + " THEN $" + orderParam + "::int");
  });

  const sql =
    "UPDATE project_pages " +
    "SET parent_id = CASE " + parentCases.join(" ") + " ELSE parent_id END, " +
    "type = CASE " + typeCases.join(" ") + " ELSE type END, " +
    "order_index = CASE " + orderCases.join(" ") + " ELSE order_index END, " +
    "updated_at = NOW() " +
    "WHERE project_id = $1 AND id IN (" + ids.join(", ") + ") " +
    "RETURNING *";

  logQuery("updateProjectPageOrder", values);
  const result = await query(sql, values);
  return result.rows.map(toProjectPage);
}

module.exports = {
  createProjectPage,
  updateProjectPageStatus,
  updateProjectPageScanResult,
  getNextQueuedProjectPage,
  claimNextQueuedProjectPage,
  clearProjectPageScreenshot,
  deleteProjectPagesByIds,
  findProjectPageById,
  findProjectPagesByProjectId,
  seedProjectPagesIfEmpty,
  updateProjectPageTitle,
  updateProjectPageOrder
};
