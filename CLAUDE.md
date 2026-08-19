# grounded-opportunity-engine

The shared **Opportunity Finder engine**: search sources → find candidates →
assess against an org profile → explain fit → **human verifies**. Part of
Grounded. Per the GROUNDED vision, nodes are THIN CONFIGURATIONS of this
engine — when one tenant needs a feature it lands here and every tenant
inherits it. Consumers: **node-leadfinder** (L2B, entity `tender` + `company`)
first; fundraising tenants (Positive Vibes — gated on concept-note approval)
next; Develop AI as tenant zero.

**Current tag: `v0.1.0`.** Consumed like the runtime:
`github:pauldevelopai/grounded-opportunity-engine#vX.Y.Z` — bump version,
commit, move the tag, then bump the pin in each consumer (npm caches github
deps: `rm -rf node_modules/@developai && npm install` to force).

## What the engine owns vs what a consumer owns

| Engine (here) | Consumer (the Node) |
|---|---|
| Arithmetic scoring — generic rule evaluators (`range`, `grade_within`, `keyword_any`, `runway`, `completeness`), `registerEvaluator` for domain rules | Seed/starter criteria (business assumptions are tenant config) |
| Versioned per-entity criteria machinery (one active per tenant+entity, monotonic versions) | Its Postgres schema + `ensureSchema` (engine standard tables: `sources`, `criteria_versions`, `criteria_weights`, `raw_items`, the entity table, flags, `runs`) |
| Pipeline: raw-item dedup → checkpoint 1 → score → checkpoint 2 → route → audit spine, honest per-source counts | Source adapters (OCDS, RSS, scrapers, uploads) — a source's shape is domain knowledge |
| AI-checkpoint machinery (`makeFieldExtractor` / `makeEvidenceExtractor`), model call **dependency-injected** | The prompts, the field normalisation, and the model call itself (own key or `host.ai`) |
| `toCorpusRecord()` — the corpus-shape contract (verification_status born `ai_drafted`; `human_verified` requires a named person; outcome field) | Writing projections to the corpus API when it exists; outcome capture UX |

## Locked decisions (do not undo)
- **Scoring is arithmetic, never model-decided.** The model extracts fields and
  quotes evidence at exactly two checkpoints; it never sets a band or score.
- **Zero npm dependencies.** The pg pool and the chat function are injected.
  Keep it that way — it's what lets one engine serve a standalone Node
  (own key, own pool) and a runtime-hosted Node (`host.ai`) identically.
- **The reference schema is LeadFinder's** (`node-leadfinder/lib/schema.js`,
  ported from tracker migration 131). New consumers create the same standard
  tables in their own schema; `runsBandColumns` exists only because the
  reference tables predate the engine (`tenders_green`…) — new schemas should
  name them `items_green`/`items_amber`/`items_red`.
- **Verification is a named person's act** — `toCorpusRecord` throws on
  `human_verified` without `verified_by`. No fake data anywhere: unwired
  adapters return nothing, missing fields stay null/"Not stated".

## Entity spec (how a consumer configures the pipeline)
See the JSDoc on `createPipeline` in `src/pipeline.js`. The live example is
`node-leadfinder/lib/pipeline.js` — a thin file that builds the spec (schema
`leadfinder`, table `tenders`, first-class column map, LeadFinder's two
extractors) and re-exports the configured pipeline under its legacy names.

## What does NOT belong here
Domain adapters, prompts, seed criteria, UI, schedulers, document intake — all
consumer code. The tracker's `server/services/leadfinder/*` copies are STALE
forks predating this package; they are retired at cutover, never extended.
