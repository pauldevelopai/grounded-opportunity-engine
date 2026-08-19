// Opportunity engine — the corpus record projection.
//
// The GROUNDED vision: everything a node gathers accumulates in the corpora
// (for opportunities, the "news & opportunities archive"), wearing the standard
// record shape. The corpus API does not exist yet — this module is the CONTRACT
// half built ahead of it: consumers project their entities through
// toCorpusRecord() so that when the API lands, the write-back is a transport
// change, not a data-model retrofit.
//
// Standard shape (vision, Aug 2026): source_url · date · jurisdiction ·
// language · licence · verification_status (born 'ai_drafted', flipped to
// 'human_verified' only by a named person) · outcome (the most valuable field
// we collect: applied/won/dismissed — null until known).

const VERIFICATION_STATUSES = ['ai_drafted', 'human_verified'];

/**
 * Normalise one scored entity into a corpus-shaped record. Throws on records
 * that would corrupt the corpus (no title, an invalid verification claim, or a
 * human_verified record with no named verifier — verification is a person's
 * signature, never a default).
 */
export function toCorpusRecord({
  collection = 'news_opportunities',
  title,
  source_url = null,
  date = null,              // the record's own date (published/closing), ISO string
  jurisdiction = null,      // e.g. 'ZA', 'ZM', 'global'
  language = null,          // e.g. 'en'
  licence = null,           // licence of the source material, if known
  summary = null,
  entity = null,            // 'tender' | 'funding_call' | 'company' | …
  tenant = null,            // which tenant's pipeline produced it (newsroom_id)
  verification_status = 'ai_drafted',
  verified_by = null,       // named person — REQUIRED when human_verified
  outcome = null,           // 'applied' | 'won' | 'dismissed' | consumer ladder value
  extra = {},               // consumer-specific fields, kept under one key
} = {}) {
  if (!title || !String(title).trim()) throw new Error('corpus record needs a title');
  if (!VERIFICATION_STATUSES.includes(verification_status)) {
    throw new Error(`verification_status must be one of ${VERIFICATION_STATUSES.join(', ')}`);
  }
  if (verification_status === 'human_verified' && !verified_by) {
    throw new Error('human_verified requires verified_by — verification is a named person\'s act');
  }
  return {
    collection,
    title: String(title).trim().slice(0, 500),
    source_url,
    date,
    jurisdiction,
    language,
    licence,
    summary,
    entity,
    tenant,
    verification_status,
    verified_by,
    outcome,
    extra,
    projected_at: new Date().toISOString(),
  };
}
