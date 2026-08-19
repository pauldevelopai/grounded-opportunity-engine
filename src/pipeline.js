// Opportunity engine — the pipeline: raw item -> extract fields (checkpoint 1)
// -> score deterministically against the tenant's ACTIVE criteria -> evidence +
// qualification (checkpoint 2) -> route green/amber/red -> persist the full
// audit spine (per-component scores, the criteria version that scored it, the
// routing reason, evidence flags). Everything is tenant-scoped by newsroom_id.
//
// The engine is configured once per consumer with an ENTITY SPEC — the consumer
// names its schema and tables, maps its first-class columns, and supplies its
// two AI checkpoints. That is what makes one engine serve tenders (L2B),
// funding calls (fundraising tenants) and whatever comes next: the flow, audit
// spine, dedup and honest counts are shared; the domain is config.

import crypto from 'node:crypto';
import { scoreEntity } from './scoring.js';
import { ensureStarterCriteria } from './criteria.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// green auto-qualifies; amber to the review queue; red rejected.
export function bandToStatus(band) {
  return band === 'green' ? 'qualified' : band === 'amber' ? 'needs_review' : 'rejected';
}

// Fill blanks in the extraction from fields the SOURCE stated outright (feed
// hints). Only ever fills a null/"Not stated" — a value the extractor found in
// the text always wins, so this can't overwrite a reading with a guess.
const BLANK = (v) => v == null || /^\s*(not stated|n\/?a|unknown|-)?\s*$/i.test(String(v));

export function applyHints(extracted, hints) {
  if (!hints) return extracted;
  const out = { ...extracted };
  const filled = [];
  for (const [k, v] of Object.entries(hints)) {
    if (v == null || v === '') continue;
    if (BLANK(out[k])) { out[k] = v; filled.push(k); }
  }
  if (filled.length) out.hint_filled = filled;   // auditable: which fields came from the feed
  return out;
}

/**
 * Build a configured pipeline from an entity spec:
 * {
 *   pool,                      // pg pool (consumer-owned)
 *   schema: 'leadfinder',      // the consumer's Postgres schema
 *   entity: 'tender',          // criteria entity name
 *   table: 'tenders',          // the scored-entity table
 *   flags: { table: 'tender_flags', fk: 'tender_id' },
 *   rawEntityFk: 'tender_id',  // raw_items column pointing at the created entity
 *   runsBandColumns: { green: 'tenders_green', amber: 'tenders_amber', red: 'tenders_red' },
 *   columns: [                 // first-class columns beyond the standard spine,
 *     { col: 'reference_no', from: 'reference_no' }, …   // from = extracted key
 *   ],
 *   starterCriteria,           // consumer seed data for ensureStarterCriteria
 *   extractFields,             // checkpoint 1: async (text) => extracted
 *   extractEvidence,           // checkpoint 2: async (text, extracted, score) => {flags, qualification_note}
 *   presentResult,             // optional: (extracted) => fields merged into each result (for digests/UI)
 * }
 */
export function createPipeline(spec) {
  for (const k of ['pool', 'schema', 'entity', 'table', 'flags', 'rawEntityFk', 'starterCriteria', 'extractFields', 'extractEvidence']) {
    if (!spec[k]) throw new Error(`createPipeline: spec.${k} is required`);
  }
  const { pool, schema, table } = spec;
  const bandCols = spec.runsBandColumns || { green: 'tenders_green', amber: 'tenders_amber', red: 'tenders_red' };
  const columns = spec.columns || [];

  async function getCriteria(newsroomId, createdBy = null) {
    return ensureStarterCriteria(pool, schema, newsroomId, {
      entity: spec.entity, starter: spec.starterCriteria, createdBy,
      notes: spec.starterNotes || 'Starter criteria (auto-seeded) — tune in-app',
    });
  }

  // ── ingest one item: extract -> score -> evidence -> route -> persist ──────
  async function ingestItem({ newsroomId, sourceId, text, criteria, externalId, url = null, hints = null }) {
    const extId = externalId || sha(text).slice(0, 32);

    // Raw item first (deduped per source). If it already exists, skip re-processing.
    const { rows: [raw] } = await pool.query(
      `INSERT INTO ${schema}.raw_items (newsroom_id, source_id, external_id, url, content, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (source_id, external_id) DO NOTHING
       RETURNING id`,
      [newsroomId, sourceId, extId, url, text]
    );
    if (!raw) return { duplicate: true, external_id: extId };

    // Checkpoint 1 — fields, then backfill anything the source stated outright.
    const extracted = applyHints(await spec.extractFields(text), hints);
    // Deterministic scoring against the tenant's criteria.
    const scoreResult = scoreEntity(extracted, criteria);
    // Checkpoint 2 — evidence + qualification (never re-scores).
    const evidence = await spec.extractEvidence(text, extracted, scoreResult);

    const status = bandToStatus(scoreResult.band);
    const colNames = columns.map((c) => c.col);
    const colValues = columns.map((c) => (typeof c.from === 'function' ? c.from(extracted) : extracted[c.from] ?? null));
    const spine = ['extracted', 'component_scores', 'total_score', 'criteria_version_id', 'band', 'routing_reason', 'status'];
    const all = ['newsroom_id', 'source_id', 'raw_item_id', ...colNames, ...spine];
    const values = [
      newsroomId, sourceId, raw.id, ...colValues,
      JSON.stringify(extracted), JSON.stringify(scoreResult.component_scores),
      scoreResult.total, criteria.version_id, scoreResult.band, scoreResult.routing_reason, status,
    ];
    const casts = { extracted: '::jsonb', component_scores: '::jsonb' };
    const placeholders = all.map((name, i) => `$${i + 1}${casts[name] || ''}`);
    const { rows: [entityRow] } = await pool.query(
      `INSERT INTO ${schema}.${table} (${all.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
      values
    );

    // Evidence flags (checkpoint 2) — plus the reviewer note as its own flag.
    const flags = [...evidence.flags];
    if (evidence.qualification_note) {
      flags.push({ flag_type: 'reviewer_note', severity: 2, confidence: 1.0, evidence_note: evidence.qualification_note });
    }
    for (const f of flags) {
      await pool.query(
        `INSERT INTO ${schema}.${spec.flags.table} (${spec.flags.fk}, flag_type, severity, confidence, evidence_note)
         VALUES ($1,$2,$3,$4,$5)`,
        [entityRow.id, f.flag_type, f.severity, f.confidence, f.evidence_note]
      );
    }

    await pool.query(
      `UPDATE ${schema}.raw_items SET status = 'extracted', ${spec.rawEntityFk} = $2 WHERE id = $1`,
      [raw.id, entityRow.id]
    );

    return {
      entity_id: entityRow.id,
      band: scoreResult.band,
      total: scoreResult.total,
      status,
      routing_reason: scoreResult.routing_reason,
      flags: flags.length,
      ...(spec.presentResult ? spec.presentResult(extracted) : {}),
    };
  }

  // ── run the pipeline over a batch of items, logging a run for the digest ───
  async function runPipeline({ newsroomId, sourceId, items, createdBy = null }) {
    const criteria = await getCriteria(newsroomId, createdBy);

    const { rows: [run] } = await pool.query(
      `INSERT INTO ${schema}.runs (newsroom_id, source_id, status) VALUES ($1, $2, 'running') RETURNING id`,
      [newsroomId, sourceId]
    );

    const results = [];
    const tally = { seen: 0, new: 0, green: 0, amber: 0, red: 0, duplicate: 0, error: 0 };
    const perSource = {}; // sourceId -> { seen, new } for source-level telemetry
    for (const item of items) {
      tally.seen++;
      // A batched run passes sourceId:null and stamps each item with its own
      // sourceId — raw_items.source_id is NOT NULL, so honour the per-item
      // source and only fall back to the call-level one (the upload path).
      const sid = item.sourceId || sourceId;
      if (sid) (perSource[sid] ||= { seen: 0, new: 0 }).seen++;
      try {
        const r = await ingestItem({ newsroomId, sourceId: sid, criteria, text: item.text, externalId: item.externalId, url: item.url, hints: item.hints });
        if (r.duplicate) { tally.duplicate++; continue; }
        tally.new++;
        tally[r.band]++;
        if (sid) perSource[sid].new++;
        results.push(r);
      } catch (err) {
        tally.error++;
        results.push({ error: err.message, item: item.externalId || null });
      }
    }

    await pool.query(
      `UPDATE ${schema}.runs
          SET finished_at = NOW(), status = $2, items_seen = $3, items_new = $4,
              ${bandCols.green} = $5, ${bandCols.amber} = $6, ${bandCols.red} = $7, error = $8
        WHERE id = $1`,
      [run.id, tally.error && !tally.new ? 'error' : 'success', tally.seen, tally.new,
       tally.green, tally.amber, tally.red, tally.error ? `${tally.error} item error(s)` : null]
    );

    // Source-level counters (cumulative), so a Sources UI shows real "items seen /
    // new" per source rather than a stuck 0.
    for (const [sid, c] of Object.entries(perSource)) {
      await pool.query(
        `UPDATE ${schema}.sources SET items_seen = items_seen + $2, items_new = items_new + $3, updated_at = NOW() WHERE id = $1`,
        [sid, c.seen, c.new]
      );
    }

    return { run_id: run.id, criteria_version: criteria.version, digest: tally, results, perSource };
  }

  return { ingestItem, runPipeline, getCriteria };
}
