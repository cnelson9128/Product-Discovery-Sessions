'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { needsBackfill } = require('../api/admin-backfill-requirements-done');

test('needsBackfill is true only for a complete feature not yet flagged requirementsDone', function () {
  assert.equal(needsBackfill({ complete: true, requirementsDone: false }), true);
  assert.equal(needsBackfill({ complete: true }), true, 'requirementsDone missing entirely still needs it');
  assert.equal(needsBackfill({ complete: true, requirementsDone: true }), false, 'already correct');
  assert.equal(needsBackfill({ complete: false, requirementsDone: false }), false, 'not complete, nothing to backfill');
  assert.equal(needsBackfill({ complete: false, requirementsDone: true }), false);
});

test('running the backfill twice is a no-op the second time', function () {
  const features = [
    { id: 'a', complete: true, requirementsDone: false },
    { id: 'b', complete: true, requirementsDone: true },
    { id: 'c', complete: false, requirementsDone: false }
  ];
  const firstPass = features.filter(needsBackfill);
  assert.deepEqual(firstPass.map(function (f) { return f.id; }), ['a']);

  // Simulate the endpoint's write.
  const corrected = features.map(function (f) {
    return f.id === 'a' ? Object.assign({}, f, { requirementsDone: true }) : f;
  });

  const secondPass = corrected.filter(needsBackfill);
  assert.deepEqual(secondPass, [], 'nothing left needing correction');
});
