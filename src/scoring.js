// Opportunity engine — deterministic scoring (the "score trust" core).
//
// LOCKED DECISION (LeadFinder build brief §5, adopted engine-wide): scoring is
// ARITHMETIC against the tenant's criteria config — never model-decided. The
// model only extracts fields and quotes evidence; it never sets a band.
//
// This is a GENERIC rule evaluator: each criteria component carries a `rule`
// (JSONB in <schema>.criteria_weights) that maps an extracted field to a 0..1
// sub-score, so a tenant's assumptions live in editable, versioned config —
// adding or changing a component needs no code change. The same evaluator
// scores any entity (tenders, companies, funding calls…): the entity is just
// the object whose fields the rules read.
//
// Lifted verbatim from node-leadfinder/lib/scoring.js (proven in production
// use for L2B); the starter criteria seed data stayed behind in the consumer —
// seeds are tenant config, not engine logic.

// ── field coercion helpers (extracted values may be strings or "Not stated") ──
const NOT_STATED = (v) => v == null || /^\s*(not stated|n\/?a|unknown|-)?\s*$/i.test(String(v));

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// "CIDB grade 3 ME or higher" / "Grade 5" / "3" -> 3 (generic small-int level)
function toGrade(v) {
  if (v == null) return null;
  const m = String(v).match(/\b([1-9])\b/);
  return m ? parseInt(m[1], 10) : null;
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// ── keyword matching, shared by keyword_any and keyword_none ────────────────
// One implementation on purpose: "does this term appear" must mean exactly the
// same thing whether a match is what the tenant wants or what they refuse.
function haystack(rule, extracted) {
  const fields = rule.fields || (rule.field ? [rule.field] : []);
  // A field may hold an array (themes, geographies) — flatten rather than
  // stringifying to "[object Object]".
  const hay = fields
    .map((f) => (Array.isArray(extracted[f]) ? extracted[f].join(' ') : String(extracted[f] || '')))
    .join(' ').toLowerCase().trim();
  return { hay, fields };
}

// Two deliberately different boundary rules, because the two directions have
// opposite costs.
//
// INCLUDING (keyword_any) uses a word-START match: "road" hits road/roads/
// roadworks but not "broadband". Over-matching a bit is what you want — the
// worst case is a call surfaced for review.
//
// EXCLUDING (keyword_none) uses a WHOLE-word match (plural tolerated): "arms"
// must not silently bin the Armstrong Foundation. A missed exclusion is
// recoverable — a person sees the call and rejects it. A false exclusion is
// invisible: a legitimate funder routed red and never looked at. So exclusion
// is the conservative one.
function firstKeywordHit(keywords, hay, { whole = false } = {}) {
  return (keywords || []).find((k) => {
    const kw = String(k).trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!kw) return false;
    return new RegExp(whole ? `\\b${kw}(?:s|es)?\\b` : '\\b' + kw).test(hay);
  });
}

// ── the rule evaluators — each returns { score: 0..1, note } ─────────────────
// A rule's `field` names a key in the extracted object.
export const EVALUATORS = {
  // numeric field inside an ideal band; linear falloff outside to hard bounds.
  range(rule, extracted) {
    const val = toNumber(extracted[rule.field]);
    if (val == null) return { score: rule.missing_score ?? 0.3, note: `${rule.field} not stated` };
    const { ideal_min = 0, ideal_max = Infinity, hard_min = 0, hard_max = Infinity } = rule;
    if (val >= ideal_min && val <= ideal_max) return { score: 1, note: `${rule.field} in ideal range` };
    // Outside the ideal band, the score falls away LINEARLY towards the hard
    // bound. With no hard bound on that side there is nothing to fall away
    // towards: hard_max defaults to Infinity, and (Infinity - val) /
    // (Infinity - ideal_max) is NaN, which then poisons the WHOLE item —
    // `weighted += NaN` makes the total NaN, every band comparison is false,
    // and the item silently lands in amber reading "score NaN". So an absent
    // hard bound means "nothing out here is disqualifying", which scores full
    // marks rather than nothing.
    if (val < ideal_min) {
      if (!Number.isFinite(hard_min)) return { score: 1, note: `${rule.field} below ideal, no hard floor set` };
      const s = clamp01((val - hard_min) / Math.max(1, ideal_min - hard_min));
      return { score: s, note: `${rule.field} below ideal` };
    }
    if (!Number.isFinite(hard_max)) return { score: 1, note: `${rule.field} above ideal, no hard ceiling set` };
    const s = clamp01((hard_max - val) / Math.max(1, hard_max - ideal_max));
    return { score: s, note: `${rule.field} above ideal` };
  },

  // a required grade/level must be within the tenant's capability.
  grade_within(rule, extracted) {
    const required = toGrade(extracted[rule.field]);
    if (required == null) return { score: rule.missing_score ?? 0.5, note: 'grade not stated' };
    const cap = rule.business_max_grade ?? 9;
    if (required <= cap) return { score: 1, note: `required grade ${required} within capability ${cap}` };
    return { score: 0, note: `required grade ${required} exceeds capability ${cap}` };
  },

  // any of the keywords appears in the field(s) -> fit. Accepts `fields: [...]`
  // (scan several) or a single `field`; matching across title+description matters
  // for feed sources whose title is a terse reference, not the subject.
  keyword_any(rule, extracted) {
    const { hay, fields } = haystack(rule, extracted);
    if (!hay) return { score: rule.missing_score ?? 0.3, note: `${fields.join('/') || 'field'} empty` };
    const hit = firstKeywordHit(rule.keywords, hay);
    return hit
      ? { score: 1, note: `matched "${hit}"` }
      : { score: rule.miss_score ?? 0.2, note: 'no keyword match' };
  },

  // The inverse: NONE of the keywords may appear. This is how a tenant's own
  // "we will not touch this" list becomes arithmetic — the funders, sectors or
  // conditions an org rules out, the clients a business won't bid for. A hit
  // scores 0, so listing the component in thresholds.hard_rules routes it red
  // outright whatever else it scores; `hard: true` on the rule does the same
  // without the threshold entry.
  //
  // Safe when unconfigured, which matters because an empty exclusion list is
  // the normal state: no keywords (or nothing to read) scores 1 and excludes
  // nothing. It never invents a reason to reject.
  keyword_none(rule, extracted) {
    const { hay } = haystack(rule, extracted);
    if (!hay) return { score: rule.missing_score ?? 1, note: 'nothing to check' };
    const hit = firstKeywordHit(rule.keywords, hay, { whole: true });
    return hit
      ? { score: 0, note: `ruled out: matched "${hit}"`, hard: !!rule.hard }
      : { score: 1, note: 'nothing ruled out' };
  },

  // enough runway before the closing date to prepare a competitive response.
  runway(rule, extracted, now) {
    const close = toDate(extracted[rule.field]);
    if (!close) return { score: rule.missing_score ?? 0.3, note: 'closing date not stated' };
    const days = (close.getTime() - now.getTime()) / 86400000;
    const { ideal_min_days = 14, hard_min_days = 2 } = rule;
    if (days < hard_min_days) return { score: 0, note: `only ${Math.round(days)}d to close`, hard: true };
    if (days >= ideal_min_days) return { score: 1, note: `${Math.round(days)}d runway` };
    return { score: clamp01((days - hard_min_days) / Math.max(1, ideal_min_days - hard_min_days)), note: `${Math.round(days)}d runway (tight)` };
  },

  // share of key fields actually present (data completeness).
  completeness(rule, extracted) {
    const fields = rule.fields || [];
    if (!fields.length) return { score: 1, note: 'no fields configured' };
    const present = fields.filter((f) => !NOT_STATED(extracted[f])).length;
    return { score: present / fields.length, note: `${present}/${fields.length} key fields present` };
  },
};

/**
 * Consumers with a domain-specific rule type register it here (e.g. a
 * fundraising node adding `theme_overlap`). Registration is additive and
 * name-collision-checked so one consumer can't silently redefine another's
 * semantics — shared engine, shared meanings.
 */
export function registerEvaluator(type, fn) {
  if (EVALUATORS[type]) throw new Error(`evaluator "${type}" is already registered`);
  EVALUATORS[type] = fn;
}

// ── score one entity against a criteria config ──────────────────────────────
// criteria = { weights: [{component, weight, rule}], thresholds: {green_min,
// red_max, hard_rules?} }. Returns per-component RAW scores (persisted, not just
// the total), the weighted total (0..100), band, and the reason that fired.
export function scoreEntity(extracted, criteria, now = new Date()) {
  const weights = criteria.weights || [];
  const componentScores = {};
  let hardFail = null;
  let weighted = 0;
  let weightSum = 0;

  for (const w of weights) {
    const evalFn = EVALUATORS[w.rule?.type];
    const res = evalFn ? evalFn(w.rule, extracted, now) : { score: 0, note: `unknown rule "${w.rule?.type}"` };
    const score = clamp01(res.score);
    componentScores[w.component] = { score, weight: w.weight, note: res.note, source: w.source || 'prior' };
    weighted += score * w.weight;
    weightSum += w.weight;
    // A rule can flag a hard fail (e.g. deadline already effectively passed).
    if (res.hard && !hardFail) hardFail = `${w.component}: ${res.note}`;
    // Config-declared hard rule: component score of 0 auto-rejects.
    if ((criteria.thresholds?.hard_rules || []).includes(w.component) && score === 0 && !hardFail) {
      hardFail = `${w.component} failed a hard rule (${res.note})`;
    }
  }

  const total = weightSum > 0 ? (weighted / weightSum) * 100 : 0;
  const { green_min = 70, red_max = 40 } = criteria.thresholds || {};

  let band, routing_reason;
  if (hardFail) {
    band = 'red';
    routing_reason = `hard rule: ${hardFail}`;
  } else if (total >= green_min) {
    band = 'green';
    routing_reason = `score ${total.toFixed(1)} ≥ green threshold ${green_min}`;
  } else if (total <= red_max) {
    band = 'red';
    routing_reason = `score ${total.toFixed(1)} ≤ red threshold ${red_max}`;
  } else {
    band = 'amber';
    routing_reason = `score ${total.toFixed(1)} between ${red_max} and ${green_min} — needs review`;
  }

  return { component_scores: componentScores, total: Math.round(total * 10) / 10, band, routing_reason };
}
