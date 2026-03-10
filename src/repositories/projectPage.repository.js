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
    const offset = index * 8;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, NOW(), NOW())`
    );
    values.push(
      page.id || generateId("pg"),
      String(projectId),
      page.title || "Untitled",
      page.url ?? null,
      page.type || "page",
      page.parentId ?? null,
      page.status || "queued",
      Number.isFinite(page.orderIndex) ? page.orderIndex : index
    );
  });

  logQuery("seedProjectPagesIfEmpty.insertProjectPages", values);
  console.log("PROJECT_AREA_QUERY_FIXED", "seedProjectPagesIfEmpty.insertProjectPages");
  await query(
    `INSERT INTO project_pages (
      id, project_id, title, url, type, parent_id, status, order_index, created_at, updated_at
    ) VALUES ${placeholders.join(", ")}`,
    values
  );

  return findProjectPagesByProjectId(projectId);
}

module.exports = {
  findProjectPagesByProjectId,
  seedProjectPagesIfEmpty
};
