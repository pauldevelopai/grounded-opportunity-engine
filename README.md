# grounded-opportunity-engine

The shared Opportunity Finder engine for **Grounded** (Develop AI): search
sources → find candidates → assess against an org profile → explain fit →
a human verifies. One engine, many tenants — a tender-lead business, a
fundraising non-profit and Develop AI itself run the same pipeline with
different config.

- **Deterministic scoring** against tenant-owned, versioned criteria — the
  model never decides a band, it only extracts fields and quotes evidence.
- **Audit spine on every record**: per-component scores, the criteria version
  that scored it, the routing reason, verbatim evidence flags.
- **Honest ingestion**: per-source dedup, incremental pulls, real seen/new
  counts, and adapters that return nothing rather than invent data.
- **Corpus-shaped output**: every record can project to the Grounded standard
  shape (source, date, jurisdiction, verification status, outcome).

Zero npm dependencies — the Postgres pool and the model call are injected by
the consumer. See `CLAUDE.md` for the engine/consumer split and the entity
spec; `node-leadfinder` is the reference consumer.

By **Develop AI** · part of [Grounded](https://grounded.developai.co.za).
