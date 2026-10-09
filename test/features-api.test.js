'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePatch, applyPatch, toRestoredFields, historyForRestore } = require('../api/features');

test('validatePatch accepts the five known fields', function () {
  const patch = validatePatch({ bucket: 'launch', module: 'search-match', owner: 'Jane', complete: true, requirementsDone: false });
  assert.deepEqual(patch.errors, []);
  assert.deepEqual(patch.out, { bucket: 'launch', module: 'search-match', owner: 'Jane', complete: true, requirementsDone: false });
});

test('validatePatch rejects model-authored fields', function () {
  const patch = validatePatch({ item: 'hacked', rationale: 'hacked', supporting_session_ids: ['x'] });
  assert.deepEqual(patch.out, {});
  assert.deepEqual(patch.errors, ['Nothing to update.']);
});

test('validatePatch rejects an unknown bucket or module', function () {
  assert.ok(validatePatch({ bucket: 'not-a-bucket' }).errors.length);
  assert.ok(validatePatch({ module: 'not-a-module' }).errors.length);
});

test('applyPatch leaves module/history alone on a bucket-only or owner-only change', function () {
  const feature = { module: 'search-match', moduleHistory: [], isManualModule: false };
  const out = applyPatch(feature, { bucket: 'launch', owner: 'Jane' });
  assert.deepEqual(out, { bucket: 'launch', owner: 'Jane' });
});

test('applyPatch sets isManualModule and appends moduleHistory on a module change', function () {
  const feature = { module: 'search-match', moduleHistory: [], isManualModule: false };
  const out = applyPatch(feature, { module: 'job-workflows' });
  assert.equal(out.isManualModule, true);
  assert.equal(out.moduleHistory.length, 1);
  assert.equal(out.moduleHistory[0].from, 'search-match');
  assert.equal(out.moduleHistory[0].to, 'job-workflows');
});

test('applyPatch does not append history when the module is set to its current value', function () {
  const feature = { module: 'search-match', moduleHistory: [], isManualModule: false };
  const out = applyPatch(feature, { module: 'search-match' });
  assert.equal(out.isManualModule, undefined);
  assert.equal(out.moduleHistory, undefined);
});

test('applyPatch preserves prior history entries', function () {
  const feature = {
    module: 'search-match',
    moduleHistory: [{ at: '2026-01-01T00:00:00.000Z', from: 'job-workflows', to: 'search-match' }],
    isManualModule: true
  };
  const out = applyPatch(feature, { module: 'pay-bill' });
  assert.equal(out.moduleHistory.length, 2);
  assert.equal(out.moduleHistory[0].to, 'search-match');
  assert.equal(out.moduleHistory[1].to, 'pay-bill');
});

test('applyPatch marks requirementsDone true whenever complete is set true', function () {
  const feature = { module: 'search-match', complete: false, requirementsDone: false };
  const out = applyPatch(feature, { complete: true });
  assert.equal(out.complete, true);
  assert.equal(out.requirementsDone, true);
});

test('applyPatch overrides an explicit requirementsDone:false in the same patch when complete is true', function () {
  // Shouldn't happen from the UI (they're separate controls), but the
  // invariant is "complete implies done," not "whichever came last wins."
  const feature = { module: 'search-match', complete: false, requirementsDone: false };
  const out = applyPatch(feature, { complete: true, requirementsDone: false });
  assert.equal(out.requirementsDone, true);
});

test('applyPatch does not touch requirementsDone when reopening a completed feature', function () {
  const feature = { module: 'search-match', complete: true, requirementsDone: true };
  const out = applyPatch(feature, { complete: false });
  assert.equal(out.complete, false);
  assert.equal(out.requirementsDone, undefined, 'reopening does not un-mark requirements as done');
});

test('applyPatch leaves requirementsDone alone on a requirementsDone-only patch', function () {
  const feature = { module: 'search-match', complete: false, requirementsDone: false };
  const out = applyPatch(feature, { requirementsDone: true });
  assert.deepEqual(out, { requirementsDone: true });
});

test('toRestoredFields maps a classification result onto feature field names', function () {
  const restored = toRestoredFields({
    primary_module: 'pay-bill',
    secondary_modules: ['job-workflows'],
    confidence: 'medium',
    classification_reason: 'About timesheet approvals.'
  });
  assert.deepEqual(restored, {
    module: 'pay-bill',
    secondaryModules: ['job-workflows'],
    confidence: 'medium',
    classificationReason: 'About timesheet approvals.'
  });
});

test('historyForRestore only records an entry when the restored module actually differs', function () {
  const feature = { module: 'job-workflows', moduleHistory: [] };
  const sameModule = historyForRestore(feature, { module: 'job-workflows' });
  assert.deepEqual(sameModule, []);

  const differentModule = historyForRestore(feature, { module: 'search-match' });
  assert.equal(differentModule.length, 1);
  assert.equal(differentModule[0].from, 'job-workflows');
  assert.equal(differentModule[0].to, 'search-match');
});
