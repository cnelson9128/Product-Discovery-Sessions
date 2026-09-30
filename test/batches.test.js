'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const batches = require('../lib/batches');

test('BATCH_IDS has exactly 8 entries, each unique', function () {
  assert.equal(batches.BATCH_IDS.length, 8);
  assert.equal(new Set(batches.BATCH_IDS).size, 8);
});

test('isValidBatch accepts every known id and rejects unknown ones', function () {
  batches.BATCH_IDS.forEach(function (id) { assert.equal(batches.isValidBatch(id), true); });
  assert.equal(batches.isValidBatch('batch-9'), false);
  assert.equal(batches.isValidBatch('search-match'), false, 'a module id is not a batch id');
});

test('labelFor/descriptionFor return the right batch, and fall back sanely for an unknown id', function () {
  assert.equal(batches.labelFor('batch-3'), 'Batch 3');
  assert.match(batches.descriptionFor('batch-3'), /Indeed/);
  assert.equal(batches.labelFor('nope'), 'nope');
  assert.equal(batches.descriptionFor('nope'), '');
});
