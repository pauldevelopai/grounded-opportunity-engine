// @developai/grounded-opportunity-engine — public surface.
//
// One engine: search sources → find candidates → assess against an org profile
// → explain fit → human verifies. Consumers (Nodes) are thin configurations:
// they own their schema, adapters, prompts and seed criteria; the engine owns
// the flow, the arithmetic scoring, the audit spine, and the honest counts.

export { EVALUATORS, registerEvaluator, scoreEntity } from './scoring.js';
export { getActiveCriteria, ensureStarterCriteria } from './criteria.js';
export { ensureSource, markSourceFetch } from './sources.js';
export { parseJson, makeFieldExtractor, makeEvidenceExtractor } from './ai.js';
export { createPipeline, bandToStatus, applyHints } from './pipeline.js';
export { toCorpusRecord } from './corpus.js';
