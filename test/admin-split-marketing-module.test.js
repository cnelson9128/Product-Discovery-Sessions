'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  OLD_COMBINED_MODULE,
  needsSessionItemReview,
  needsFeatureReview
} = require('../api/admin-split-marketing-module');

test('OLD_COMBINED_MODULE matches the id business-development-marketing kept in lib/modules.js', function () {
  assert.equal(OLD_COMBINED_MODULE, 'business-development-marketing');
});

test('needsSessionItemReview is true only for a raised item still under the old combined module', function () {
  assert.equal(needsSessionItemReview({ primary_module: 'business-development-marketing' }), true);
  assert.equal(needsSessionItemReview({ primary_module: 'marketing' }), false, 'already split out');
  assert.equal(needsSessionItemReview({ primary_module: 'search-match' }), false, 'unrelated module untouched');
  assert.equal(needsSessionItemReview(null), false);
});

test('needsFeatureReview is true for any card still under the old combined module, manually overridden or not', function () {
  // Module membership only — the handler's loop decides whether a manually
  // overridden card is actually reclassified (it isn't) or just counted as
  // skipped, so this predicate can't pre-filter overrides out itself without
  // making that count impossible to report.
  assert.equal(needsFeatureReview({ module: 'business-development-marketing', isManualModule: false }), true);
  assert.equal(needsFeatureReview({ module: 'business-development-marketing', isManualModule: true }), true);
  assert.equal(needsFeatureReview({ module: 'marketing', isManualModule: false }), false, 'already split out');
  assert.equal(needsFeatureReview({ module: 'search-match', isManualModule: false }), false, 'unrelated module untouched');
});

test('running the migration twice stops re-selecting items that already moved to marketing', function () {
  // Simulates the endpoint's own write for an item that moved.
  const item = { primary_module: 'business-development-marketing' };
  assert.equal(needsSessionItemReview(item), true);
  item.primary_module = 'marketing'; // what the endpoint would set on a move
  assert.equal(needsSessionItemReview(item), false, 'second run skips it — already moved');

  const feature = { module: 'business-development-marketing', isManualModule: false };
  assert.equal(needsFeatureReview(feature), true);
  feature.module = 'marketing';
  assert.equal(needsFeatureReview(feature), false, 'second run skips it — already moved');
});

test('an item that genuinely stays Business Development is still selected on a later run (known, documented limitation)', function () {
  // Not a strict no-op: the endpoint re-asks the classifier for anything
  // still tagged with the old combined id, including items correctly
  // confirmed as Business Development on a prior run. Safe (idempotent in
  // effect) but not free — documented in the endpoint's own header comment.
  const item = { primary_module: 'business-development-marketing' };
  assert.equal(needsSessionItemReview(item), true, 'still selected even after a prior run confirmed it as BD');
});
