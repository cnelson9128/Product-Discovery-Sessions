'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePatch, applyPatch, toRestoredFields, historyForRestore, validateEvidence, validateEpicFields, epicFeatureIds, withEpicAssignments } = require('../api/features');

test('validatePatch accepts the six known fields', function () {
  const patch = validatePatch({ bucket: 'launch', module: 'search-match', owner: 'Jane', complete: true, requirementsDone: false, linkedTicket: 'MOON-411' });
  assert.deepEqual(patch.errors, []);
  assert.deepEqual(patch.out, { bucket: 'launch', module: 'search-match', owner: 'Jane', complete: true, requirementsDone: false, linkedTicket: 'MOON-411' });
});

test('validatePatch trims linkedTicket and rejects one that is too long', function () {
  assert.equal(validatePatch({ linkedTicket: '  MOON-411  ' }).out.linkedTicket, 'MOON-411');
  assert.deepEqual(validatePatch({ linkedTicket: '' }).out, { linkedTicket: '' }, 'an empty string clears it');
  assert.ok(validatePatch({ linkedTicket: 'x'.repeat(51) }).errors.length);
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

test('applyPatch clears epicId when a module change moves a grouped card out of its epic\'s module', function () {
  const feature = { module: 'search-match', moduleHistory: [], isManualModule: false, epicId: 'epic-1' };
  const out = applyPatch(feature, { module: 'job-workflows' });
  assert.equal(out.epicId, null);
});

test('applyPatch leaves epicId untouched on a bucket/owner-only patch', function () {
  const feature = { module: 'search-match', moduleHistory: [], isManualModule: false, epicId: 'epic-1' };
  const out = applyPatch(feature, { bucket: 'launch' });
  assert.equal(out.epicId, undefined);
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

test('applyPatch clears a pending autoCompleteSuggestion whenever complete is set true', function () {
  const feature = { module: 'search-match', complete: false, autoCompleteSuggestion: { confidence: 'medium', reason: 'r', commitShas: ['abc'] } };
  const out = applyPatch(feature, { complete: true });
  assert.equal(out.requirementsDone, true);
  assert.equal(out.autoCompleteSuggestion, null);
});

test('validateEvidence requires a reason and at least one commit sha', function () {
  assert.ok(validateEvidence({}, {}).errors.some(function (e) { return /reason is required/.test(e); }));
  assert.ok(validateEvidence({ reason: 'did the thing' }, {}).errors.some(function (e) { return /commitShas must be/.test(e); }));

  const ok = validateEvidence({ reason: 'did the thing', commitShas: ['abc123', 'def456'] }, {});
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.out, { reason: 'did the thing', commitShas: ['abc123', 'def456'] });
});

test('validateEvidence rejects too many commit shas or an oversized reason', function () {
  const tooMany = validateEvidence({ reason: 'r', commitShas: new Array(21).fill('a') }, {});
  assert.ok(tooMany.errors.length);

  const tooLong = validateEvidence({ reason: 'x'.repeat(501), commitShas: ['a'] }, {});
  assert.ok(tooLong.errors.length);
});

test('validateEvidence requires a known confidence level only when requireConfidence is set', function () {
  const withoutRequirement = validateEvidence({ reason: 'r', commitShas: ['a'] }, {});
  assert.deepEqual(withoutRequirement.errors, []);

  const missing = validateEvidence({ reason: 'r', commitShas: ['a'] }, { requireConfidence: true });
  assert.ok(missing.errors.some(function (e) { return /confidence must be/.test(e); }));

  const bad = validateEvidence({ reason: 'r', commitShas: ['a'], confidence: 'certain' }, { requireConfidence: true });
  assert.ok(bad.errors.some(function (e) { return /confidence must be/.test(e); }));

  const good = validateEvidence({ reason: 'r', commitShas: ['a'], confidence: 'medium' }, { requireConfidence: true });
  assert.deepEqual(good.errors, []);
  assert.equal(good.out.confidence, 'medium');
});

const FEATURES = [
  { id: 'f1', module: 'search-match', isEpic: false },
  { id: 'f2', module: 'search-match', isEpic: false },
  { id: 'f3', module: 'search-match', isEpic: false },
  { id: 'e1', module: 'search-match', isEpic: true, bullets: [{ id: 'b1', text: 'x', featureIds: ['f1'] }] }
];

test('validateEpicFields accepts a well-formed epic and defaults bucket to bau', function () {
  const v = validateEpicFields({
    module: 'search-match',
    title: 'Lead management',
    bullets: [{ text: 'Multiple pipelines', featureIds: ['f1', 'f2'] }, { text: 'Drag and drop boards', featureIds: ['f3'] }]
  }, FEATURES);
  assert.deepEqual(v.errors, []);
  assert.equal(v.out.bucket, 'bau');
  assert.equal(v.out.title, 'Lead management');
  assert.equal(v.out.bullets.length, 2);
  assert.deepEqual(v.out.bullets[0].featureIds, ['f1', 'f2']);
});

test('validateEpicFields rejects an unknown module, missing title, or empty bullets', function () {
  assert.ok(validateEpicFields({ module: 'nope', title: 't', bullets: [{ text: 'x', featureIds: ['f1'] }] }, FEATURES).errors.length);
  assert.ok(validateEpicFields({ module: 'search-match', title: '', bullets: [{ text: 'x', featureIds: ['f1'] }] }, FEATURES).errors.length);
  assert.ok(validateEpicFields({ module: 'search-match', title: 't', bullets: [] }, FEATURES).errors.length);
});

test('validateEpicFields rejects a bullet citing an unknown card, another epic, or a duplicate card', function () {
  assert.ok(validateEpicFields({ module: 'search-match', title: 't', bullets: [{ text: 'x', featureIds: ['nope'] }] }, FEATURES).errors.length);
  assert.ok(validateEpicFields({ module: 'search-match', title: 't', bullets: [{ text: 'x', featureIds: ['e1'] }] }, FEATURES).errors.length, 'cannot link to another epic');
  const dup = validateEpicFields({
    module: 'search-match', title: 't',
    bullets: [{ text: 'a', featureIds: ['f1'] }, { text: 'b', featureIds: ['f1'] }]
  }, FEATURES);
  assert.ok(dup.errors.length, 'same card used in two bullets of one epic');
});

test('validateEpicFields accepts an explicit valid bucket and rejects an invalid one', function () {
  const ok = validateEpicFields({ module: 'search-match', bucket: 'launch', title: 't', bullets: [{ text: 'x', featureIds: ['f1'] }] }, FEATURES);
  assert.equal(ok.out.bucket, 'launch');
  const bad = validateEpicFields({ module: 'search-match', bucket: 'nope', title: 't', bullets: [{ text: 'x', featureIds: ['f1'] }] }, FEATURES);
  assert.ok(bad.errors.length);
});

test('epicFeatureIds flattens every bullet\'s featureIds', function () {
  const epic = { bullets: [{ featureIds: ['f1', 'f2'] }, { featureIds: ['f3'] }] };
  assert.deepEqual(epicFeatureIds(epic), ['f1', 'f2', 'f3']);
});

test('withEpicAssignments sets epicId on newly-cited cards and clears it from dropped ones', function () {
  const items = [
    { id: 'f1', epicId: null },
    { id: 'f2', epicId: 'e1' },
    { id: 'f3', epicId: null }
  ];
  const next = withEpicAssignments(items, 'e1', ['f2'], ['f1', 'f3']);
  assert.equal(next.find(function (f) { return f.id === 'f1'; }).epicId, 'e1');
  assert.equal(next.find(function (f) { return f.id === 'f2'; }).epicId, null, 'dropped from this epic');
  assert.equal(next.find(function (f) { return f.id === 'f3'; }).epicId, 'e1');
});

test('withEpicAssignments never steals a card another epic already claimed', function () {
  const items = [{ id: 'f1', epicId: 'other-epic' }];
  const next = withEpicAssignments(items, 'e1', ['f1'], []);
  assert.equal(next[0].epicId, 'other-epic', 'only clears epicId that points at this same epic');
});
