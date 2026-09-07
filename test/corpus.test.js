// The corpus contract. These are the rules that decide whether the corpus is
// evidence a journalist, litigator or regulator can rely on, or just a pile of
// model output — so they are enforced here rather than trusted to each Node.
//
// From CLAUDE.md: verification_status is born 'ai_drafted' and flips to
// 'human_verified' ONLY by a named person; toCorpusRecord throws otherwise.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toCorpusRecord } from '../src/index.js';

const base = { title: 'Community health grant', entity: 'funding_call' };

describe('a record is born ai_drafted', () => {
  test('the default status is ai_drafted, never verified', () => {
    // Nothing the model produced may present itself as checked by a person.
    assert.equal(toCorpusRecord(base).verification_status, 'ai_drafted');
    assert.equal(toCorpusRecord(base).verified_by, null);
  });

  test('the default collection is the opportunities archive', () => {
    assert.equal(toCorpusRecord(base).collection, 'news_opportunities');
  });
});

describe('verification is a named person\'s act', () => {
  test('human_verified without a named verifier is refused', () => {
    assert.throws(
      () => toCorpusRecord({ ...base, verification_status: 'human_verified' }),
      /verification is a named person/i,
      'a verified record with nobody\'s name on it must never enter the corpus');
  });

  test('human_verified with a named verifier is accepted', () => {
    const r = toCorpusRecord({ ...base, verification_status: 'human_verified', verified_by: 'paul@developai.co.za' });
    assert.equal(r.verification_status, 'human_verified');
    assert.equal(r.verified_by, 'paul@developai.co.za');
  });

  test('an empty or whitespace name does not count as a name', () => {
    for (const who of ['', null, undefined]) {
      assert.throws(() => toCorpusRecord({ ...base, verification_status: 'human_verified', verified_by: who }),
        /verification is a named person/i, `verified_by=${JSON.stringify(who)} must be refused`);
    }
  });

  test('an invented status is refused', () => {
    assert.throws(() => toCorpusRecord({ ...base, verification_status: 'probably_fine' }),
      /verification_status must be one of/);
  });
});

describe('a record must be citable', () => {
  test('no title is refused — an uncitable record is worthless', () => {
    assert.throws(() => toCorpusRecord({ ...base, title: undefined }), /needs a title/);
    assert.throws(() => toCorpusRecord({ ...base, title: '   ' }), /needs a title/);
  });

  test('the standard shape is always present, null where unknown', () => {
    // Honest nulls, never invented values — the fields a reader needs to judge
    // the record: where it came from, when, which jurisdiction, what licence.
    const r = toCorpusRecord(base);
    for (const f of ['source_url', 'date', 'jurisdiction', 'language', 'licence', 'summary', 'outcome']) {
      assert.equal(r[f], null, `${f} should default to null, not a guess`);
    }
    assert.ok(r.projected_at, 'a record records when it was projected');
  });

  test('outcome rides along when known — the most valuable field', () => {
    assert.equal(toCorpusRecord({ ...base, outcome: 'won' }).outcome, 'won');
  });

  test('a very long title is truncated rather than rejected', () => {
    const r = toCorpusRecord({ ...base, title: 'x'.repeat(900) });
    assert.equal(r.title.length, 500);
  });
});
