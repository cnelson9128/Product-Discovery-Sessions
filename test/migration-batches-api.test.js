'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRosterPatch } = require('../api/migration-batches');

test('accepts up to 2 trimmed client names', function () {
  const patch = validateRosterPatch({ clients: [' Acme ', 'Beta'] });
  assert.deepEqual(patch.errors, []);
  assert.deepEqual(patch.out.clients, ['Acme', 'Beta']);
});

test('accepts a valid targetDate, or null to clear it', function () {
  assert.deepEqual(validateRosterPatch({ targetDate: '2026-03-01' }).out, { targetDate: '2026-03-01' });
  assert.deepEqual(validateRosterPatch({ targetDate: null }).out, { targetDate: null });
  assert.deepEqual(validateRosterPatch({ targetDate: '' }).out, { targetDate: null });
});

test('rejects more than 2 clients', function () {
  const patch = validateRosterPatch({ clients: ['A', 'B', 'C'] });
  assert.ok(patch.errors.length);
});

test('rejects an oversized client name', function () {
  const patch = validateRosterPatch({ clients: ['x'.repeat(201)] });
  assert.ok(patch.errors.length);
});

test('rejects a malformed date', function () {
  const patch = validateRosterPatch({ targetDate: '01/03/2026' });
  assert.ok(patch.errors.length);
});

test('requires at least one field', function () {
  const patch = validateRosterPatch({});
  assert.deepEqual(patch.errors, ['Nothing to update.']);
});

test('clients and targetDate can be patched independently', function () {
  const clientsOnly = validateRosterPatch({ clients: ['Acme'] });
  assert.deepEqual(clientsOnly.out, { clients: ['Acme'] });

  const dateOnly = validateRosterPatch({ targetDate: '2026-06-01' });
  assert.deepEqual(dateOnly.out, { targetDate: '2026-06-01' });
});
