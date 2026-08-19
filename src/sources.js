// Opportunity engine — source bookkeeping against <schema>.sources.
//
// The engine does NOT fetch — adapters (OCDS portals, RSS, scrapers, uploads)
// are consumer code, because a source's shape is domain knowledge. What the
// engine standardises is the honest telemetry around every fetch: when a source
// last ran, whether it actually pulled, what went wrong, and cumulative
// seen/new counts — the vision's ingestion rules (incremental, stateful,
// deduped, honest counts, never a silent full re-harvest) enforced in one place.

/** Get-or-create a source for the tenant (e.g. the always-available 'upload'). */
export async function ensureSource(pool, schema, newsroomId, { name, kind = 'upload', location = null, origin = 'seed' }) {
  const { rows: [found] } = await pool.query(
    `SELECT id FROM ${schema}.sources WHERE newsroom_id = $1 AND name = $2 LIMIT 1`,
    [newsroomId, name]
  );
  if (found) return found.id;
  const { rows: [created] } = await pool.query(
    `INSERT INTO ${schema}.sources (newsroom_id, name, kind, location, origin)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [newsroomId, name, kind, location, origin]
  );
  return created.id;
}

/**
 * Record a source's fetch-attempt telemetry — called right after the adapter
 * runs. A successful pull stamps last_success_at and clears last_error; an
 * error records it; an unwired stub does neither (it never pulled).
 * last_run_at always advances. items_new/items_seen are bumped separately by
 * runPipeline, the only place that knows new-vs-duplicate per source.
 */
export async function markSourceFetch(pool, schema, sourceId, { error = null, unwired = false } = {}) {
  if (!sourceId) return;
  await pool.query(
    `UPDATE ${schema}.sources
        SET last_run_at = NOW(),
            last_success_at = CASE WHEN $2 THEN NOW() ELSE last_success_at END,
            last_error = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [sourceId, !error && !unwired, error]
  );
}
