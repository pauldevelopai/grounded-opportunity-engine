# Refit: node-leadfinder consumes the engine

**Apply ONLY after the current node-leadfinder working tree (the plan-v2
company build, in progress 2026-08-19) is committed and pushed.** The engine
was verified behaviourally identical to that working tree's scoring across
27,720 differential cases (see `../README.md`); this refit deletes the
duplicated code and re-points LeadFinder at the package. No schema change, no
data change, no behaviour change — L2B's tables and results are untouched.

## 1. Dependency

`package.json` — add (and later replace `file:` with the github tag once the
`pauldevelopai/grounded-opportunity-engine` repo exists):

```json
"@developai/grounded-opportunity-engine": "github:pauldevelopai/grounded-opportunity-engine#v0.1.0"
```

## 2. `lib/scoring.js` → thin re-export + seed data

Keep `STARTER_CRITERIA` (seed data stays in the consumer). Replace the rest:

```js
export { scoreEntity as scoreTender, EVALUATORS, registerEvaluator } from '@developai/grounded-opportunity-engine';
export const STARTER_CRITERIA = { /* unchanged — the existing object */ };
```

## 3. `lib/extract.js` → prompts stay, machinery goes

Keep `EXTRACT_SYSTEM` / `EVIDENCE_SYSTEM` and the field normalisation
(they're LeadFinder domain config). Replace the call/parse plumbing:

```js
import { makeFieldExtractor, makeEvidenceExtractor } from '@developai/grounded-opportunity-engine';
import { callClaude } from './claude.js';

const chat = ({ system, userContent, maxTokens, temperature }) =>
  callClaude({ system, userContent, maxTokens, temperature });

export const extractTenderFields = makeFieldExtractor({
  chat, system: EXTRACT_SYSTEM, maxTokens: 1200,
  normalise: (parsed) => ({ /* the existing normalisation object, unchanged */ }),
});
export const extractEvidence = makeEvidenceExtractor({ chat, system: EVIDENCE_SYSTEM, maxTokens: 1000 });
```

NOTE the engine's user-content header is `SOURCE TEXT:` where LeadFinder's was
`TENDER NOTICE:` / `NOTICE:`. Temperature-0 extraction is header-insensitive in
our testing, but re-run one fixture through checkpoint 1 after the swap and eyeball
the fields before merging (no-fake-data rule: verify, don't assume).

## 4. `lib/pipeline.js` → entity spec + legacy names

```js
import pool from './pool.js';
import { createPipeline, ensureSource as engineEnsureSource,
         markSourceFetch as engineMarkSourceFetch, getActiveCriteria as engineGetActiveCriteria,
         ensureStarterCriteria as engineEnsureStarterCriteria } from '@developai/grounded-opportunity-engine';
import { scoreTender, STARTER_CRITERIA } from './scoring.js';   // scoreTender re-exported for companies.js
import { extractTenderFields, extractEvidence } from './extract.js';

const SCHEMA = 'leadfinder';

const pipeline = createPipeline({
  pool, schema: SCHEMA, entity: 'tender', table: 'tenders',
  flags: { table: 'tender_flags', fk: 'tender_id' },
  rawEntityFk: 'tender_id',
  runsBandColumns: { green: 'tenders_green', amber: 'tenders_amber', red: 'tenders_red' },
  columns: [
    { col: 'reference_no', from: 'reference_no' },
    { col: 'issuing_body', from: 'issuing_body' },
    { col: 'title', from: 'title' },
    { col: 'closing_date', from: (e) => e.closing_date || null },
    { col: 'estimated_value', from: 'estimated_value' },
    { col: 'cidb_grade', from: 'cidb_grade' },
  ],
  starterCriteria: STARTER_CRITERIA,
  starterNotes: 'Starter criteria (auto-seeded) — tune in LeadFinder',
  extractFields: extractTenderFields,
  extractEvidence,
  presentResult: (e) => ({ reference_no: e.reference_no, title: e.title }),
});

// Legacy surface, preserved exactly (routes.js / nightly.js / companies.js):
export const getActiveCriteria = (newsroomId, entity = 'tender') =>
  engineGetActiveCriteria(pool, SCHEMA, newsroomId, entity);
export const ensureStarterCriteria = (newsroomId, createdBy = null, opts = {}) =>
  engineEnsureStarterCriteria(pool, SCHEMA, newsroomId, {
    entity: 'tender', starter: STARTER_CRITERIA,
    notes: 'Starter criteria (auto-seeded) — tune in LeadFinder', createdBy, ...opts,
  });
export const ensureSource = (newsroomId, def) => engineEnsureSource(pool, SCHEMA, newsroomId, def);
export const markSourceFetch = (sourceId, o) => engineMarkSourceFetch(pool, SCHEMA, sourceId, o);
export const ingestTender = async (args) => {
  const r = await pipeline.ingestItem(args);
  return r.duplicate ? r : { ...r, tender_id: r.entity_id };
};
export const runPipeline = async (args) => {
  const out = await pipeline.runPipeline(args);
  return { ...out, tenders: out.results };
};
```

CHECK before applying: `companies.js` calls `ensureStarterCriteria(newsroomId,
null, { entity: 'company', starter: STARTER_COMPANY_CRITERIA, notes: … })` —
the spread above preserves that override. Re-read the file at apply time in
case the parallel build changed call shapes.

## 5. Verify (all against the LOCAL tracker DB, never the box first)

1. `npm install` (after `rm -rf node_modules/@developai` if the pin changed).
2. `node --check` every touched file; boot `npm start`.
3. Run one fixture tender through `POST /run` and diff the created
   `leadfinder.tenders` row against a pre-refit run: same band, total,
   component_scores, flags count.
4. `npm run build` (React UI unchanged but rebuild proves the tree).
5. Only then: commit on a branch, merge, redeploy per /editnode.
