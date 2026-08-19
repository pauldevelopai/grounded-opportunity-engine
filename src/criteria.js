// Opportunity engine — versioned, per-entity, tenant-owned criteria.
//
// The engine's standard tables (created by the consumer's ensureSchema; the
// LeadFinder schema is the reference implementation):
//   <schema>.criteria_versions (newsroom_id, version, entity, status, thresholds, …)
//   <schema>.criteria_weights  (criteria_version_id, component, weight, source, rule)
// One ACTIVE version per (tenant, entity); versions are monotonic per tenant
// ACROSS entities. Tuning creates a new version — history is never rewritten,
// so every stored score can name the exact criteria version that produced it.

/** Load the tenant's ACTIVE criteria version + weights for an entity. */
export async function getActiveCriteria(pool, schema, newsroomId, entity) {
  const { rows: [ver] } = await pool.query(
    `SELECT id, version, thresholds FROM ${schema}.criteria_versions
      WHERE newsroom_id = $1 AND entity = $2 AND status = 'active' ORDER BY version DESC LIMIT 1`,
    [newsroomId, entity]
  );
  if (!ver) return null;
  const { rows: weights } = await pool.query(
    `SELECT component, weight::float AS weight, source, rule
       FROM ${schema}.criteria_weights WHERE criteria_version_id = $1`,
    [ver.id]
  );
  return { version_id: ver.id, version: ver.version, thresholds: ver.thresholds || {}, weights };
}

/**
 * Bootstrap a tenant with starter criteria (active) if they have none for the
 * entity. The starter is the CONSUMER's seed data — the engine never invents
 * business assumptions. Tuning in-app creates new versions.
 */
export async function ensureStarterCriteria(pool, schema, newsroomId, {
  entity, starter, notes = 'Starter criteria (auto-seeded) — tune in-app', createdBy = null,
}) {
  if (!entity) throw new Error('ensureStarterCriteria: entity is required');
  if (!starter) throw new Error('ensureStarterCriteria: starter criteria (consumer seed data) are required');
  const existing = await getActiveCriteria(pool, schema, newsroomId, entity);
  if (existing) return existing;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [mx] } = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS v FROM ${schema}.criteria_versions WHERE newsroom_id = $1`, [newsroomId]);
    const { rows: [ver] } = await client.query(
      `INSERT INTO ${schema}.criteria_versions (newsroom_id, version, entity, status, thresholds, notes, created_by, activated_at)
       VALUES ($1, $2, $3, 'active', $4::jsonb, $5, $6, NOW())
       RETURNING id`,
      [newsroomId, mx.v + 1, entity, JSON.stringify(starter.thresholds), notes, createdBy]
    );
    for (const w of starter.weights) {
      await client.query(
        `INSERT INTO ${schema}.criteria_weights (criteria_version_id, component, weight, source, rule)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [ver.id, w.component, w.weight, w.source || 'prior', JSON.stringify(w.rule)]
      );
    }
    await client.query('COMMIT');
    return getActiveCriteria(pool, schema, newsroomId, entity);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
