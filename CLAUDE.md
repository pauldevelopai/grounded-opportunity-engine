# grounded-opportunity-engine

The shared **Opportunity Finder engine**: search sources → find candidates →
assess against an org profile → explain fit → **human verifies**. Part of
Grounded. Per the GROUNDED vision, nodes are THIN CONFIGURATIONS of this
engine — when one tenant needs a feature it lands here and every tenant
inherits it. Consumers: **node-leadfinder** (L2B, entity `tender` + `company`)
first; fundraising tenants (Positive Vibes — gated on concept-note approval)
next; Develop AI as tenant zero.

**Current tag: `v0.2.1`** — pushed (2026-09-07). v0.2.1 is the first version with
tests, and fixes the NaN they found (see below). Consumed like the runtime:
`github:pauldevelopai/grounded-opportunity-engine#vX.Y.Z` — bump version,
commit, move the tag, then bump the pin in each consumer.

**Bumping a consumer's pin takes more than clearing the cache.** The usual
remedy (`rm -rf node_modules/@developai && npm install`) is NOT enough on its
own: the lockfile pins the old *commit SHA*, and npm honours that over an
edited `package.json`, silently reinstalling the version you just bumped away
from. Measured on LeadFinder's v0.1.0 → v0.2.0 bump. What re-resolves it:

```bash
npm install "github:pauldevelopai/grounded-opportunity-engine#vX.Y.Z"
```

Then check `package-lock.json` actually moved to the new SHA before committing.

**Push the tag in the same breath as the commit.** A consumer's lockfile records
the resolved *commit SHA*, not the tag, so an unpushed tag fails an off-laptop
`npm ci` twice over — neither ref resolves. v0.2.0 sat local-only for a while
with `node-resources` already pinning it; that only stayed harmless because the
pin was on a feature branch and its `main` still pinned `v0.1.0`.

## What the engine owns vs what a consumer owns

| Engine (here) | Consumer (the Node) |
|---|---|
| Arithmetic scoring — generic rule evaluators (`range`, `grade_within`, `keyword_any`, `keyword_none`, `runway`, `completeness`), `registerEvaluator` for domain rules | Seed/starter criteria (business assumptions are tenant config) |
| Versioned per-entity criteria machinery (one active per tenant+entity, monotonic versions) | Its Postgres schema + `ensureSchema` (engine standard tables: `sources`, `criteria_versions`, `criteria_weights`, `raw_items`, the entity table, flags, `runs`) |
| Pipeline: raw-item dedup → checkpoint 1 → score → checkpoint 2 → route → audit spine, honest per-source counts | Source adapters (OCDS, RSS, scrapers, uploads) — a source's shape is domain knowledge |
| AI-checkpoint machinery (`makeFieldExtractor` / `makeEvidenceExtractor`), model call **dependency-injected** | The prompts, the field normalisation, and the model call itself (own key or `host.ai`) |
| `toCorpusRecord()` — the corpus-shape contract (verification_status born `ai_drafted`; `human_verified` requires a named person; outcome field) | Writing projections to the corpus API when it exists; outcome capture UX |

## Tests (`npm test`) — 34, still zero dependencies

`node --test` only. The zero-dependency rule is a locked decision and it applies
to the tests too — no framework, no devDependency.

They exist because this engine's most important behaviours are the ones a later
session would "tidy up". `test/scoring.test.js` pins the **keyword asymmetry**
in executable form: including matches word-START, excluding matches WHOLE words
plural-tolerated, and one test asserts the same term behaves *differently* in
the two directions from identical input — so merging them into one matcher
fails immediately. It also covers that scoring is deterministic and
model-free, that bands come from thresholds, that a hard rule routes red over
any score, and that `registerEvaluator` refuses to silently replace an existing
evaluator. `test/corpus.test.js` pins the corpus contract: born `ai_drafted`,
and `human_verified` without a named person throws.

**Mutation-tested, which is the only reason to trust them.** Merging the two
matchers fails 3, making `keyword_any` a substring match fails 1, making
`keyword_none` reject when unconfigured fails 1, dropping the `human_verified`
check fails 2, reintroducing the NaN below fails 2. If you add a test here,
break the code and confirm it bites first.

### The bug the tests found: an unbounded `range` returned NaN

`hard_max` defaults to `Infinity`, so a value above `ideal_max` computed
`(Infinity - val) / (Infinity - ideal_max)` — **NaN**. That NaN did not stay in
its own component: `weighted += NaN` made the whole ITEM's total NaN, every band
comparison was then false, and the item fell through to **amber** with
`routing_reason: "score NaN between 35 and 65"`. One unbounded rule silently
destroyed an entire item's routing.

Fixed in v0.2.1: an absent hard bound now means "nothing out here is
disqualifying" and scores 1. A bounded range still falls away linearly —
unchanged. It was latent rather than live: LeadFinder's `sector_fit`,
`has_cidb` and `has_contact` rules all set `ideal_max` without `hard_max`, but
the first is documented 0..1 and the others are strict 0/1, so nothing exceeded
the ideal in practice. A model returning `sector_fit: 1.2` would have triggered
it.

## Locked decisions (do not undo)
- **Scoring is arithmetic, never model-decided.** The model extracts fields and
  quotes evidence at exactly two checkpoints; it never sets a band or score.
- **Including and excluding match differently, on purpose** (v0.2.0).
  `keyword_any` matches word-START ("road" hits roadworks) — over-matching is
  cheap, the worst case is a candidate surfaced for review. `keyword_none`
  matches WHOLE words, plural tolerated ("arms" must not bin the Armstrong
  Foundation; "casino" still catches "casinos"). A missed exclusion is
  recoverable because a person sees the item; a false exclusion is invisible —
  a legitimate candidate routed red and never looked at. Do not "simplify"
  these into one matcher.
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

## Field lessons that bind consumers (paid for in production, 2026-08-19)
- **Tenancy is the consumer's job, always.** The engine never resolves who the
  tenant is — `newsroomId` is a parameter on every call. Do not wire tenancy to
  the runtime's `tenantOf()`: in runtime v0.14–v0.15 it pins hosted tenants to
  the JWT user id, which breaks any consumer whose tables FK
  `public.newsrooms(id)` (LeadFinder resolves in-Node: JWT `newsroom_id`, else
  `team_members` lookup, fail closed — copy that until the runtime is fixed).
- **Some feeds mutate old records — the incremental-window rule inverts.**
  OCDS eTenders awards appear on releases MONTHS after the advertised window
  (measured: 244 recent releases → 0 awards; 9 aged Jan–Mar releases → 9
  awards). An adapter for such a feed must walk an AGED window (e.g. now−270d →
  now−60d) and skip individual failing pages rather than abort — a partial walk
  is kept, not discarded. Dedup on (source, external_id) is what makes the
  re-walk cheap and idempotent.

## What does NOT belong here
Domain adapters, prompts, seed criteria, UI, schedulers, document intake — all
consumer code. The tracker's `server/services/leadfinder/*` copies are STALE
forks predating this package; they are retired at cutover, never extended.
