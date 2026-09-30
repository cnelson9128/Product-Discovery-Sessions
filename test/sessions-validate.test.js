'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateFields } = require('../api/sessions');

const CLIENTS = ['Acme Recruiting', 'Beta Staffing'];
const ROSTER = {
  'batch-3': { clients: ['Batch3 Client A', 'Batch3 Client B'], targetDate: '2026-03-01' },
  'batch-4': { clients: ['Only One Filled', ''], targetDate: null }
};

function discoveryBody(overrides) {
  return Object.assign({
    interviewer: 'Sam',
    customerName: 'Acme Recruiting',
    module: 'search-match',
    sessionDate: '2026-01-01'
  }, overrides);
}

function migrationBody(overrides) {
  return Object.assign({
    track: 'migration-readiness',
    interviewer: 'Sam',
    customerName: 'Batch3 Client A',
    batch: 'batch-3',
    sessionDate: '2026-01-01'
  }, overrides);
}

test('discovery path is unchanged: requires a managed client and a valid module', function () {
  const ok = validateFields(discoveryBody(), CLIENTS, ROSTER);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.out.track, 'discovery');
  assert.equal(ok.out.module, 'search-match');
  assert.equal(ok.out.batch, null);

  const badClient = validateFields(discoveryBody({ customerName: 'Not Managed Ltd' }), CLIENTS, ROSTER);
  assert.ok(badClient.errors.some(function (e) { return /managed clients/.test(e); }));

  const badModule = validateFields(discoveryBody({ module: 'not-a-module' }), CLIENTS, ROSTER);
  assert.ok(badModule.errors.some(function (e) { return /module must be/.test(e); }));
});

test('migration-readiness path requires a valid batch and skips module entirely', function () {
  const ok = validateFields(migrationBody(), CLIENTS, ROSTER);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.out.track, 'migration-readiness');
  assert.equal(ok.out.batch, 'batch-3');
  assert.equal(ok.out.module, null);

  const noBatch = validateFields(migrationBody({ batch: undefined }), CLIENTS, ROSTER);
  assert.ok(noBatch.errors.some(function (e) { return /batch is required/.test(e); }));

  const badBatch = validateFields(migrationBody({ batch: 'batch-99' }), CLIENTS, ROSTER);
  assert.ok(badBatch.errors.some(function (e) { return /batch is required/.test(e); }));
});

test('migration-readiness customerName must be on that specific batch\'s locked roster', function () {
  const wrongBatch = validateFields(migrationBody({ customerName: 'Beta Staffing' }), CLIENTS, ROSTER);
  assert.ok(wrongBatch.errors.some(function (e) { return /locked clients/.test(e); }));

  const otherBatchesClient = validateFields(
    migrationBody({ batch: 'batch-4', customerName: 'Batch3 Client A' }),
    CLIENTS, ROSTER
  );
  assert.ok(otherBatchesClient.errors.some(function (e) { return /locked clients/.test(e); }), 'a batch-3 client is not valid for batch-4');

  const filledSlot = validateFields(migrationBody({ batch: 'batch-4', customerName: 'Only One Filled' }), CLIENTS, ROSTER);
  assert.deepEqual(filledSlot.errors, []);

  const emptySlot = validateFields(migrationBody({ batch: 'batch-4', customerName: '' }), CLIENTS, ROSTER);
  assert.ok(emptySlot.errors.some(function (e) { return /customerName is required/.test(e); }));
});

test('an unconfigured batch (no roster entry yet) rejects every customerName', function () {
  const res = validateFields(migrationBody({ batch: 'batch-1', customerName: 'Anyone' }), CLIENTS, {});
  assert.ok(res.errors.some(function (e) { return /locked clients/.test(e); }));
});
