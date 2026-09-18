'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeSessionFeatures } = require('../lib/feature-sync');

function raised(overrides) {
  return Object.assign({
    item: 'Bulk shortlist export',
    rationale: 'Raised repeatedly by recruiters.',
    evidence: 'we just want to export our shortlist',
    primary_module: 'search-match',
    secondary_modules: [],
    confidence: 'high',
    classification_reason: 'About searching/shortlisting candidates.'
  }, overrides);
}

test('creates a new feature per raised item, classified by content', function () {
  const session = { id: 'sess-1', raisedItems: [raised()] };
  const { features, created, updated } = mergeSessionFeatures(session, []);

  assert.equal(created, 1);
  assert.equal(updated, 0);
  assert.equal(features.length, 1);
  const f = features[0];
  assert.equal(f.module, 'search-match');
  assert.equal(f.sourceSessionId, 'sess-1');
  assert.equal(f.sourceItemKey, 'sess-1#0');
  assert.deepEqual(f.supporting_session_ids, ['sess-1']);
  assert.equal(f.isManualModule, false);
  assert.deepEqual(f.moduleHistory, []);
  assert.equal(f.bucket, 'bau');
  assert.equal(f.owner, '');
  assert.equal(f.complete, false);
  assert.equal(f.requirementsDone, false);
});

test('re-syncing the same session updates a non-overridden card in place, not a duplicate', function () {
  const session1 = { id: 'sess-1', raisedItems: [raised({ item: 'Bulk shortlist export' })] };
  const first = mergeSessionFeatures(session1, []);

  const session2 = { id: 'sess-1', raisedItems: [raised({ item: 'Bulk shortlist export (revised wording)' })] };
  const second = mergeSessionFeatures(session2, first.features);

  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.features.length, 1);
  assert.equal(second.features[0].item, 'Bulk shortlist export (revised wording)');
  assert.equal(second.features[0].id, first.features[0].id, 'same card, not a new one');
});

test('never touches module/confidence/classificationReason on a manually-overridden card', function () {
  const session1 = { id: 'sess-1', raisedItems: [raised({ primary_module: 'search-match', confidence: 'low' })] };
  const first = mergeSessionFeatures(session1, []);

  const overridden = first.features.slice();
  overridden[0] = Object.assign({}, overridden[0], {
    module: 'job-workflows',
    isManualModule: true,
    confidence: 'high',
    classificationReason: 'Manually moved by a human.'
  });

  const session2 = {
    id: 'sess-1',
    raisedItems: [raised({ item: 'Bulk shortlist export — updated text', primary_module: 'search-match', confidence: 'low' })]
  };
  const second = mergeSessionFeatures(session2, overridden);

  assert.equal(second.features[0].module, 'job-workflows', 'module untouched by parser');
  assert.equal(second.features[0].confidence, 'high', 'confidence untouched by parser');
  assert.equal(second.features[0].classificationReason, 'Manually moved by a human.', 'reason untouched by parser');
  assert.equal(second.features[0].item, 'Bulk shortlist export — updated text', 'text still refreshes');
});

test('links a card back to its originating session via sourceItemKey', function () {
  const session = {
    id: 'sess-9',
    raisedItems: [raised({ item: 'First item' }), raised({ item: 'Second item' })]
  };
  const { features } = mergeSessionFeatures(session, []);
  assert.equal(features[0].sourceItemKey, 'sess-9#0');
  assert.equal(features[1].sourceItemKey, 'sess-9#1');
});

test('leaves an orphaned card alone when a re-extraction shrinks the raised-items list', function () {
  const session1 = {
    id: 'sess-1',
    raisedItems: [raised({ item: 'Item A' }), raised({ item: 'Item B' })]
  };
  const first = mergeSessionFeatures(session1, []);
  assert.equal(first.features.length, 2);

  const session2 = { id: 'sess-1', raisedItems: [raised({ item: 'Item A' })] };
  const second = mergeSessionFeatures(session2, first.features);

  assert.equal(second.features.length, 2, 'orphaned card is not deleted');
  const itemB = second.features.find(function (f) { return f.sourceItemKey === 'sess-1#1'; });
  assert.ok(itemB, 'card for the now-missing item still exists');
  assert.equal(itemB.item, 'Item B', 'left exactly as it was');
});
