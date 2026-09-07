# How different organisations use one engine

The engine's claim is that a new organisation is a **configuration**, not a
build. This is the evidence for that claim, and the template for the next one:
two live configurations laid side by side, with the line between what changes
and what never does.

Read it before configuring a third org, and before adding anything to the
engine — if a "missing feature" turns out to be something one of these two
already expresses as config, it does not belong in the engine.

## The two worked examples

Both are the same pipeline — search sources → find candidates → assess against
an org profile → explain fit → **a human verifies**. Everything below is the
part each org supplies.

| | **Tender watching** (`node-leadfinder`) | **Fundraising** (`node-resources`) |
|---|---|---|
| **Who it is for** | A business that sells to contractors and needs to know which public tenders are worth bidding. First used by L2B. | A non-profit that needs funding calls it can realistically win. First user Positive Vibes. |
| **Entities scored** | **Two**: `tender` (the opportunity) and `company` (the buyer worth calling) | **One**: `funding_call` |
| **Schema** | `leadfinder` | `resources` |
| **Sources** | OCDS eTenders (structured feed, incremental), CIDB grading lookups, document upload | grants.gov (free, no key), AI web scan guided by the org's own criteria, document upload |
| **What "good" means** | Likely to **convert**: can we qualify, does the job fit, is the value worth bidding, is there time | Likely to be **won**: does the theme match, do we work there, is the grant the right size, is there time to write it |
| **Bands** | green ≥ 70, red ≤ 40 | green ≥ 65, red ≤ 35 |
| **Hard rules** (a zero here routes red whatever else scores) | `eligibility_fit`, `deadline_runway`, `sector_fit` | `deadline_runway`, `exclusions` |
| **Corpus collection** | news & opportunities archive | news & opportunities archive |

### The criteria, component by component

This is where the two organisations actually diverge — and note that **every
row uses an evaluator the engine already had**. Neither needed new engine code.

| Evaluator | Tender watching | Fundraising |
|---|---|---|
| `grade_within` | `eligibility_fit` (3.0) — CIDB grade within the business's capability | — |
| `range` | `value_fit` (2.0) — R100k–5m ideal, hard ceiling 20m | `grant_size` (0, inert until the org states a range) |
| `keyword_any` | `sector_fit` (2.5) — 25 construction trades; `miss_score: 0` so an off-sector job scores nothing | `theme_fit` (3.0) and `geography_fit` (2.0) — from the org's own criteria card |
| `keyword_none` | — | `exclusions` (1.0) — the funders and conditions the org refuses |
| `runway` | `deadline_runway` (1.5) — 14 days ideal, 3 days hard floor | `deadline_runway` (2.0) — 21 days ideal, 5 days hard floor |
| `completeness` | (1.0) — reference, issuing body, closing date, value, contact | (1.0) — title, funder, closing date, eligibility, summary |

Two things worth reading off that table:

- **The same evaluator carries different business meaning.** `range` is a
  contract value in one and a grant size in the other. `runway` is "time to
  prepare a bid" versus "time to write an application", and the thresholds
  differ because writing a proposal takes longer than pricing a job.
- **The weights encode a worldview.** Tender watching puts eligibility first
  (3.0) — you cannot bid what you cannot qualify for. Fundraising puts theme
  first (3.0) — a funder whose priorities don't match yours will not fund you
  however well you write. Same arithmetic, different convictions.

## What NEVER changes

These are engine, and a new org gets them for free:

- **The model never scores.** It extracts fields at checkpoint 1 and quotes
  evidence at checkpoint 2. Bands come from arithmetic against the tenant's own
  criteria. Every routing decision can be explained after the fact from the
  stored `component_scores`.
- **Criteria are versioned per tenant+entity**, monotonic, one active at a
  time, and every scored item records the `criteria_version_id` that produced
  it — so "did the new criteria do better" stays answerable.
- **The two keyword matchers stay asymmetric** — including matches word-start,
  excluding matches whole words. See the locked decisions in `CLAUDE.md`.
- **Raw-item dedup, the audit spine, honest per-source counts.**
- **The corpus contract.** Records are born `ai_drafted`; `human_verified`
  requires a named person or `toCorpusRecord` throws.
- **Tenancy is the consumer's job.** `newsroomId` is a parameter on every
  engine call; the engine never resolves who the tenant is.

## What ALWAYS changes

The checklist for a new organisation, in the order it actually gets decided:

1. **What is the entity?** The thing being scored, named in the org's own
   language — a tender, a funding call, a scholarship, a procurement notice.
   One Node can score more than one (tender watching scores two).
2. **What does "good" mean, in the org's words?** Write the sentence before
   writing any config. "Likely to convert" and "likely to be won" produced two
   quite different weightings above.
3. **Which components express that sentence?** Map each to an existing
   evaluator. Reach for `registerEvaluator` only when nothing fits — and if you
   do, the rule belongs in the Node, not the engine, unless a second org would
   use it.
4. **What does the org refuse?** `keyword_none`, whole-word matched. Often the
   most valuable thing a client tells you, and the easiest to forget to ask.
5. **What are the sources?** A source's shape is domain knowledge and belongs
   in the Node. Structured feeds beat scraping; an authenticated/paid source
   needs the terms checked before any code (see `node-resources/NODE.md`).
6. **What are the prompts?** Consumer config. Extraction returns fields;
   evidence returns quotes and an honest fit note, including for weak fits.
7. **Where do outcomes come from?** Who records applied/won/lost, and where the
   UI asks. Outcome data is the most valuable thing collected, and it is the
   only way to know whether any of the above was right.

## The trap to avoid

**Seed criteria are business assumptions, so they are the tenant's, not the
engine's.** The starter set exists only so a new tenant is not staring at an
empty scorer on day one — the moment they tune it in-app, their version wins.
If you find yourself editing an engine default to suit one organisation, that
is the signal you are configuring the wrong layer.

The corollary, learned on `grant_size`: a component with **no configuration
yet** must be inert. An unbounded `range` scores every stated value 1, so
shipping it with a weight above zero hands every candidate a free component and
moves the band lines for everyone. Ship it at weight 0 and let the first real
configuration raise it.
