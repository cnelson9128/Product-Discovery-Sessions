'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { needsRaisedItemsBackfill, needsReclassification } = require('../api/admin-reclassify-features');
const { mergeSessionFeatures } = require('../lib/feature-sync');

test('needsRaisedItemsBackfill is true only for a session with no raisedItems array yet', function () {
  assert.equal(needsRaisedItemsBackfill({}), true);
  assert.equal(needsRaisedItemsBackfill({ raisedItems: null }), true);
  assert.equal(needsRaisedItemsBackfill({ raisedItems: [] }), false);
  assert.equal(needsRaisedItemsBackfill({ raisedItems: [{ item: 'x' }] }), false);
});

test('needsReclassification is true only for a legacy, non-overridden card', function () {
  assert.equal(needsReclassification({}), true, 'no sourceItemKey, no override -> legacy, needs it');
  assert.equal(needsReclassification({ sourceItemKey: 'sess-1#0' }), false, 'already linked to an extracted item');
  assert.equal(needsReclassification({ isManualModule: true }), false, 'human override always wins');
  assert.equal(needsReclassification({ sourceItemKey: 'sess-1#0', isManualModule: true }), false);
  assert.equal(needsReclassification({ classificationReason: 'Already classified once.' }), false, 'already-classified legacy card is not redone');
});

test('running the session-backfill pass twice is a no-op the second time', function () {
  // Simulates what api/admin-reclassify-features.js's loop does per session,
  // without touching Redis or Anthropic: a session that's already been
  // backfilled (raisedItems populated) is skipped on a second pass.
  const session = { id: 'sess-1' };
  assert.equal(needsRaisedItemsBackfill(session), true);

  const backfilled = Object.assign({}, session, { raisedItems: [{ item: 'x', primary_module: 'search-match', secondary_modules: [], confidence: 'high', classification_reason: 'r', evidence: 'e', rationale: 'r' }] });
  assert.equal(needsRaisedItemsBackfill(backfilled), false, 'second pass sees it as already done');

  // And re-syncing from the same (unchanged) raisedItems doesn't duplicate cards.
  const first = mergeSessionFeatures(backfilled, []);
  const second = mergeSessionFeatures(backfilled, first.features);
  assert.equal(second.created, 0);
  assert.equal(first.features.length, second.features.length);
});

test('running the feature-reclassification pass twice only touches legacy cards once', function () {
  const features = [
    { id: 'a', item: 'x', rationale: 'y' }, // legacy: no sourceItemKey, no override
    { id: 'b', item: 'x', rationale: 'y', sourceItemKey: 'sess-1#0' }, // already linked, skip
    { id: 'c', item: 'x', rationale: 'y', isManualModule: true } // human override, skip
  ];
  const legacyFirstPass = features.filter(needsReclassification);
  assert.deepEqual(legacyFirstPass.map(function (f) { return f.id; }), ['a']);

  // Simulate the endpoint's write: card 'a' gets classified, gaining a
  // module and — the tell that stops it being reprocessed — a
  // classificationReason.
  const reclassified = features.map(function (f) {
    return f.id === 'a'
      ? Object.assign({}, f, { module: 'search-match', confidence: 'high', classificationReason: 'About shortlisting.' })
      : f;
  });

  const legacySecondPass = reclassified.filter(needsReclassification);
  assert.deepEqual(legacySecondPass, [], 'second run is a no-op: nothing left needing reclassification');
});
