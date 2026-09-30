'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rollupBatchReadiness } = require('../lib/migration-readiness');

function entry(status, verdict) {
  return { status: status, migrationReadinessVerdict: verdict || null };
}

test('grey "not yet assessed" when no session in the batch has been analyzed', function () {
  assert.deepEqual(rollupBatchReadiness([entry('draft'), entry('draft')], 2), { level: 'grey', label: 'Not yet assessed' });
  assert.deepEqual(rollupBatchReadiness([], 2), { level: 'grey', label: 'Not yet assessed' });
});

test('grey "partial" once only one of two expected sessions is assessed', function () {
  const result = rollupBatchReadiness([entry('ready', 'ready'), entry('draft')], 2);
  assert.equal(result.level, 'grey');
  assert.equal(result.label, 'Partial assessment (1/2)');
});

test('an error-status session with no verdict does not count as assessed', function () {
  const result = rollupBatchReadiness([entry('ready', 'ready'), entry('error')], 2);
  assert.equal(result.label, 'Partial assessment (1/2)');
});

test('both ready -> green', function () {
  assert.deepEqual(rollupBatchReadiness([entry('ready', 'ready'), entry('ready', 'ready')], 2), { level: 'green', label: 'Ready' });
});

test('takes the worst of the two verdicts, not an average', function () {
  const result = rollupBatchReadiness([entry('ready', 'ready'), entry('ready', 'minor_concerns')], 2);
  assert.deepEqual(result, { level: 'amber', label: 'Minor concerns' });
});

test('a single not_ready outweighs a ready counterpart -> red', function () {
  const result = rollupBatchReadiness([entry('ready', 'ready'), entry('ready', 'not_ready')], 2);
  assert.deepEqual(result, { level: 'red', label: 'Not ready' });
});

test('major_concerns also maps to red', function () {
  const result = rollupBatchReadiness([entry('ready', 'minor_concerns'), entry('ready', 'major_concerns')], 2);
  assert.deepEqual(result, { level: 'red', label: 'Major concerns' });
});

test('expectedCount defaults to 2 when not given', function () {
  const result = rollupBatchReadiness([entry('ready', 'ready')]);
  assert.equal(result.label, 'Partial assessment (1/2)');
});

test('a batch with only one roster slot filled reaches green off one session', function () {
  const result = rollupBatchReadiness([entry('ready', 'ready')], 1);
  assert.deepEqual(result, { level: 'green', label: 'Ready' });
});
