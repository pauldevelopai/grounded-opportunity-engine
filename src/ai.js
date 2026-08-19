// Opportunity engine — the AI-checkpoint machinery.
//
// The engine talks to a model at EXACTLY two kinds of checkpoint (field
// extraction; evidence + qualification) and NEVER lets the model score. This
// module is the machinery only — the prompts are the consumer's config (a
// tender node's field list is not a fundraising node's), and the model call
// itself is DEPENDENCY-INJECTED so the engine is key- and provider-agnostic:
// LeadFinder passes its own callClaude; a runtime-based Node passes a thin
// wrapper over host.ai.chat.
//
//   chat: async ({ system, userContent, maxTokens, temperature }) => string

/** Tolerant JSON extraction from a model reply (handles code fences / stray prose). */
export function parseJson(raw) {
  const s = String(raw).replace(/```json|```/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * Checkpoint 1 factory — field extraction. Returns async (text) => extracted.
 *   system     — the consumer's extraction prompt (must demand JSON and forbid guessing)
 *   normalise  — (parsed|{}) => extracted; the consumer types/coerces its own fields
 */
export function makeFieldExtractor({ chat, system, normalise = (p) => p, maxTokens = 1200, textCap = 12000 }) {
  if (typeof chat !== 'function') throw new Error('makeFieldExtractor: a chat function is required');
  return async function extractFields(text) {
    const raw = await chat({
      system,
      userContent: `SOURCE TEXT:\n"""\n${String(text).slice(0, textCap)}\n"""`,
      maxTokens,
      temperature: 0,
    });
    return normalise(parseJson(raw) || {});
  };
}

/**
 * Checkpoint 2 factory — evidence quotes + qualification note. The routing is
 * already decided arithmetically; this asks the model to surface the verbatim
 * evidence a human reviewer needs. Returns async (text, extracted, scoreResult)
 * => { flags: [...], qualification_note }.
 */
export function makeEvidenceExtractor({ chat, system, maxTokens = 1000, textCap = 12000 }) {
  if (typeof chat !== 'function') throw new Error('makeEvidenceExtractor: a chat function is required');
  return async function extractEvidence(text, extracted, scoreResult) {
    const raw = await chat({
      system,
      userContent:
        `SOURCE TEXT:\n"""\n${String(text).slice(0, textCap)}\n"""\n\n` +
        `EXTRACTED FIELDS:\n${JSON.stringify(extracted)}\n\n` +
        `DETERMINISTIC ROUTING (already decided — explain the evidence, don't re-judge):\n` +
        `band=${scoreResult.band}, total=${scoreResult.total}, reason="${scoreResult.routing_reason}"\n` +
        `component scores: ${JSON.stringify(scoreResult.component_scores)}`,
      maxTokens,
      temperature: 0,
    });
    const parsed = parseJson(raw) || {};
    const flags = Array.isArray(parsed.flags) ? parsed.flags : [];
    return {
      flags: flags.map((f) => ({
        flag_type:     String(f.flag_type || 'other').slice(0, 60),
        severity:      Math.max(1, Math.min(5, parseInt(f.severity, 10) || 3)),
        confidence:    Math.max(0, Math.min(1, Number(f.confidence) || 0.5)),
        evidence_note: f.evidence_note ? String(f.evidence_note).slice(0, 1000) : null,
      })),
      qualification_note: parsed.qualification_note ? String(parsed.qualification_note).slice(0, 500) : null,
    };
  };
}
