// The engine's LOCKED decisions, as executable assertions.
//
// CLAUDE.md says of the two keyword matchers: "Do not 'simplify' these into one
// matcher." That is precisely the instruction a later session overrides while
// tidying up, because the two look like duplicates. They are not, and the
// asymmetry is deliberate:
//
//   INCLUDING (keyword_any)  matches word-START. Over-matching is cheap — the
//                            worst case is a candidate surfaced for review.
//   EXCLUDING (keyword_none) matches WHOLE words, plural tolerated. A missed
//                            exclusion is recoverable because a person sees the
//                            item; a FALSE exclusion is invisible — a legitimate
//                            candidate routed red and never looked at.
//
// Both consumers (LeadFinder for L2B, Resources for PV) inherit this, so a
// regression here hits two tenants at once.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EVALUATORS, registerEvaluator, scoreEntity } from '../src/index.js';

const any = (keywords, text, fields = ['title']) =>
  EVALUATORS.keyword_any({ type: 'keyword_any', fields, keywords }, { title: text });
const none = (keywords, text, fields = ['title']) =>
  EVALUATORS.keyword_none({ type: 'keyword_none', fields, keywords }, { title: text });

describe('keyword_any matches word-START (over-matching is cheap)', () => {
  test('"road" hits road, roads and roadworks', () => {
    for (const t of ['Road resurfacing', 'Rural roads programme', 'Roadworks tender']) {
      assert.equal(any(['road'], t).score, 1, `expected "${t}" to match`);
    }
  });

  test('"road" does NOT hit "broadband" — a start boundary, not a substring', () => {
    // The bug a plain includes() would reintroduce.
    assert.notEqual(any(['road'], 'Broadband rollout').score, 1);
  });

  test('matching is case-insensitive', () => {
    assert.equal(any(['ROAD'], 'road resurfacing').score, 1);
    assert.equal(any(['road'], 'ROAD RESURFACING').score, 1);
  });

  test('a miss scores the configured miss_score, not zero by default', () => {
    const r = EVALUATORS.keyword_any(
      { type: 'keyword_any', fields: ['title'], keywords: ['road'], miss_score: 0.2 },
      { title: 'Catering services' });
    assert.equal(r.score, 0.2);
  });
});

describe('keyword_none matches WHOLE words (a false exclusion is invisible)', () => {
  test('"arms" must NOT bin the Armstrong Foundation', () => {
    // The canonical example from CLAUDE.md. If this fails, a legitimate funder
    // is routed red and no human ever sees it.
    assert.equal(none(['arms'], 'Armstrong Foundation grant').score, 1,
      'Armstrong must survive an "arms" exclusion');
  });

  test('but "arms" still excludes an actual arms dealer', () => {
    assert.equal(none(['arms'], 'Small arms manufacturing').score, 0);
  });

  test('plurals are tolerated: "casino" catches "casinos"', () => {
    assert.equal(none(['casino'], 'Casinos and gaming').score, 0);
    assert.equal(none(['casino'], 'Casino development').score, 0);
  });

  test('"tobacco" does not catch an unrelated longer word', () => {
    assert.equal(none(['tobacco'], 'Tobacconist heritage archive').score, 1);
  });
});

describe('the asymmetry itself — do not merge these matchers', () => {
  // One test that fails loudly if someone routes both through one boundary rule.
  test('the same term behaves differently including vs excluding', () => {
    const INCLUDE_HITS = any(['arm'], 'Armstrong Foundation').score;
    const EXCLUDE_HITS = none(['arm'], 'Armstrong Foundation').score;
    assert.equal(INCLUDE_HITS, 1, 'including should over-match: "arm" starts "Armstrong"');
    assert.equal(EXCLUDE_HITS, 1, 'excluding should NOT match: "arm" is not a whole word here');
    // i.e. including matched, excluding did not — from identical inputs.
  });
});

describe('keyword_none is safe when unconfigured (the normal state)', () => {
  test('an empty exclusion list excludes nothing', () => {
    assert.equal(none([], 'Anything at all').score, 1);
  });

  test('nothing to read excludes nothing', () => {
    const r = EVALUATORS.keyword_none({ type: 'keyword_none', fields: ['title'], keywords: ['arms'] }, {});
    assert.equal(r.score, 1, 'an empty haystack must never invent a reason to reject');
  });

  test('it never invents a rejection from a blank keyword', () => {
    assert.equal(none(['', '   '], 'Community health grant').score, 1);
  });
});

describe('scoring is arithmetic, never model-decided', () => {
  const criteria = {
    thresholds: { green_min: 65, red_max: 35 },
    weights: [
      { component: 'theme', weight: 3, rule: { type: 'keyword_any', fields: ['title'], keywords: ['health'] } },
      { component: 'size', weight: 1, rule: { type: 'range', field: 'value', ideal_min: 100, ideal_max: 200, hard_max: 400 } },
    ],
  };

  test('the same input always gives the same band — no model in the loop', () => {
    const item = { title: 'Health programme', value: 150 };
    const a = scoreEntity(item, criteria);
    const b = scoreEntity(item, criteria);
    assert.deepEqual(a, b);
    assert.equal(a.band, 'green');
  });

  test('bands come from the thresholds, and the reason names the arithmetic', () => {
    const green = scoreEntity({ title: 'Health programme', value: 150 }, criteria);
    assert.equal(green.band, 'green');
    assert.match(green.routing_reason, /green threshold/);

    const red = scoreEntity({ title: 'Catering', value: 5000 }, criteria);
    assert.equal(red.band, 'red');
    assert.match(red.routing_reason, /red threshold/);
  });

  test('per-component raw scores are returned, not just the total', () => {
    // Persisted so a routing decision can be explained after the fact.
    const r = scoreEntity({ title: 'Health programme', value: 150 }, criteria);
    assert.equal(r.component_scores.theme.score, 1);
    assert.ok('note' in r.component_scores.theme, 'each component carries its own note');
  });

  test('an unknown rule type scores 0 and says so rather than throwing', () => {
    const r = scoreEntity({}, { thresholds: {}, weights: [{ component: 'x', weight: 1, rule: { type: 'nope' } }] });
    assert.equal(r.component_scores.x.score, 0);
    assert.match(r.component_scores.x.note, /unknown rule/);
  });
});

describe('an unbounded range never produces NaN', () => {
  // Found by writing these tests. hard_max defaults to Infinity, so a value
  // above ideal_max computed (Infinity - val) / (Infinity - ideal_max) = NaN.
  // That NaN did not stay in its own component: `weighted += NaN` made the
  // ITEM's total NaN, every band comparison was then false, and the item fell
  // through to amber reading "score NaN between 35 and 65". A whole item's
  // routing destroyed by one unbounded rule, silently.
  const unbounded = { type: 'range', field: 'value', ideal_min: 100, ideal_max: 200 };

  test('above ideal with no hard ceiling scores full marks, not NaN', () => {
    const r = EVALUATORS.range(unbounded, { value: 5000 });
    assert.ok(!Number.isNaN(r.score), 'a range score must never be NaN');
    assert.equal(r.score, 1, 'no hard ceiling means nothing out here is disqualifying');
  });

  test('the item total survives it', () => {
    const r = scoreEntity({ value: 5000 }, {
      thresholds: { green_min: 65, red_max: 35 },
      weights: [{ component: 'size', weight: 1, rule: unbounded }],
    });
    assert.ok(!Number.isNaN(r.total), 'one unbounded rule must not poison the whole total');
    assert.doesNotMatch(r.routing_reason, /NaN/);
  });

  test('a bounded range still falls away linearly (the fix changed nothing there)', () => {
    const bounded = { ...unbounded, hard_max: 400 };
    assert.equal(EVALUATORS.range(bounded, { value: 300 }).score, 0.5);
    assert.equal(EVALUATORS.range(bounded, { value: 400 }).score, 0);
  });

  test('a missing value is still "not stated", not zero', () => {
    const r = EVALUATORS.range({ ...unbounded, missing_score: 0.3 }, {});
    assert.equal(r.score, 0.3);
    assert.match(r.note, /not stated/);
  });
});

describe('a hard rule routes red whatever else the item scores', () => {
  const criteria = {
    thresholds: { green_min: 65, red_max: 35, hard_rules: ['exclusions'] },
    weights: [
      { component: 'theme', weight: 9, rule: { type: 'keyword_any', fields: ['title'], keywords: ['health'] } },
      { component: 'exclusions', weight: 1, rule: { type: 'keyword_none', fields: ['funder'], keywords: ['tobacco'] } },
    ],
  };

  test('an otherwise perfect item is still rejected on a hard-rule hit', () => {
    const r = scoreEntity({ title: 'Health programme', funder: 'Tobacco Institute' }, criteria);
    assert.equal(r.band, 'red');
    assert.match(r.routing_reason, /hard rule/);
  });

  test('and the same item passes when the exclusion does not fire', () => {
    const r = scoreEntity({ title: 'Health programme', funder: 'Wellcome Trust' }, criteria);
    assert.equal(r.band, 'green');
  });
});

describe('registerEvaluator extends the engine without forking it', () => {
  test('a domain rule can be added and then scores', () => {
    const name = `test_rule_${Math.random().toString(36).slice(2, 8)}`;
    registerEvaluator(name, (rule, extracted) => ({
      score: extracted[rule.field] === rule.expect ? 1 : 0, note: 'domain rule',
    }));
    const r = scoreEntity({ kind: 'x' }, {
      thresholds: { green_min: 50, red_max: 10 },
      weights: [{ component: 'c', weight: 1, rule: { type: name, field: 'kind', expect: 'x' } }],
    });
    assert.equal(r.component_scores.c.score, 1);
  });

  test('registering over an existing evaluator is refused', () => {
    // Silently replacing keyword_none would change every tenant's exclusions.
    assert.throws(() => registerEvaluator('keyword_any', () => ({ score: 1 })), /already registered/);
  });
});
