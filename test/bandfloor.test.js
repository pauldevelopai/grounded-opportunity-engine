// The band floor: a consumer may hold a candidate BACK, never push one forward.
//
// It exists because thresholds.hard_rules only fire on an exact component score
// of 0, so a component that merely scores badly cannot reject an item — and a
// strong total then carries a candidate that fails the one thing that matters
// into the top band. Both consumers hit it (a training company in "call first";
// an off-theme construction tender routed green to a health newsroom).
//
// The demote-only rule is the load-bearing part. Allowing promotion would let a
// consumer's config launder a weak candidate into green and quietly undo
// "scoring is arithmetic, never model-decided" — a band would stop being
// explainable from the numbers.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyBandFloor } from '../src/index.js';

const green = () => ({ band: 'green', total: 72.5, routing_reason: 'score 72.5 ≥ green threshold 65', component_scores: {} });

describe('demoting works and says why', () => {
  test('green -> amber, with the reason appended and the arithmetic untouched', () => {
    const out = applyBandFloor(
      { adjustBand: () => ({ band: 'amber', reason: 'none of your themes appear in this call' }) },
      green(), {});
    assert.equal(out.band, 'amber');
    assert.match(out.routing_reason, /score 72\.5/);              // the arithmetic still shows
    assert.match(out.routing_reason, /held back: none of your themes/);
    assert.equal(out.total, 72.5, 'the total must not be rewritten');
  });

  test('green -> red is allowed (two steps down)', () => {
    const out = applyBandFloor({ adjustBand: () => ({ band: 'red', reason: 'ineligible' }) }, green(), {});
    assert.equal(out.band, 'red');
  });

  test('a demotion with no stated reason still records that it happened', () => {
    const out = applyBandFloor({ adjustBand: () => ({ band: 'amber' }) }, green(), {});
    assert.equal(out.band, 'amber');
    assert.match(out.routing_reason, /held back/);
  });
});

describe('promotion is refused', () => {
  const cases = [
    ['amber -> green', { band: 'amber', total: 50, routing_reason: 'r', component_scores: {} }, 'green'],
    ['red -> green',   { band: 'red',   total: 20, routing_reason: 'r', component_scores: {} }, 'green'],
    ['red -> amber',   { band: 'red',   total: 20, routing_reason: 'r', component_scores: {} }, 'amber'],
  ];
  for (const [label, start, to] of cases) {
    test(`${label} is ignored`, () => {
      const out = applyBandFloor({ adjustBand: () => ({ band: to, reason: 'trust me' }) }, start, {});
      assert.equal(out.band, start.band, 'a consumer must not be able to promote');
      assert.equal(out.routing_reason, start.routing_reason, 'and nothing is recorded for a refused promotion');
    });
  }
});

describe('it is safe by default and under failure', () => {
  test('no hook means no change at all', () => {
    const g = green();
    assert.equal(applyBandFloor({}, g, {}), g);
  });

  test('returning null/undefined leaves the band alone', () => {
    for (const r of [null, undefined, false, {}]) {
      assert.equal(applyBandFloor({ adjustBand: () => r }, green(), {}).band, 'green');
    }
  });

  test('an unknown band value is ignored rather than persisted', () => {
    assert.equal(applyBandFloor({ adjustBand: () => ({ band: 'purple' }) }, green(), {}).band, 'green');
  });

  test('a hook that throws does not kill the item', () => {
    // A scan of 40 items must not die because one hook return was bad.
    const out = applyBandFloor({ adjustBand: () => { throw new Error('boom'); } }, green(), {});
    assert.equal(out.band, 'green');
  });

  test('the same band back is a no-op', () => {
    const out = applyBandFloor({ adjustBand: () => ({ band: 'green', reason: 'x' }) }, green(), {});
    assert.equal(out.routing_reason, 'score 72.5 ≥ green threshold 65');
  });
});
