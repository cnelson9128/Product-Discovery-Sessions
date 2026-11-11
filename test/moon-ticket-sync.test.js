'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { migrateState, extractTicketShas } = require('../scripts/moon-ticket-sync');

test('migrateState starts both watermarks at null when there is no prior state', function () {
  assert.deepEqual(migrateState(null), { lastTicketSha: null, lastSemanticSha: null });
});

test('migrateState carries the old single-watermark shape onto both new watermarks', function () {
  assert.deepEqual(migrateState({ lastSyncedSha: 'abc123' }), { lastTicketSha: 'abc123', lastSemanticSha: 'abc123' });
});

test('migrateState leaves the current two-watermark shape alone, including when they differ', function () {
  assert.deepEqual(
    migrateState({ lastTicketSha: 'new1', lastSemanticSha: 'old1' }),
    { lastTicketSha: 'new1', lastSemanticSha: 'old1' }
  );
});

test('extractTicketShas groups commit shas by every MOON-xxx id in their message, case-insensitively', function () {
  const commits = [
    { sha: 's1', message: 'Fix bug (moon-411)' },
    { sha: 's2', message: 'MOON-411 and MOON-500 both addressed here' },
    { sha: 's3', message: 'Unrelated chore' }
  ];
  const result = extractTicketShas(commits);
  assert.deepEqual(Array.from(result.keys()).sort(), ['MOON-411', 'MOON-500']);
  assert.deepEqual(Array.from(result.get('MOON-411')).sort(), ['s1', 's2']);
  assert.deepEqual(Array.from(result.get('MOON-500')).sort(), ['s2']);
});

test('extractTicketShas returns an empty map when no commit mentions a ticket', function () {
  const result = extractTicketShas([{ sha: 's1', message: 'Unrelated chore' }]);
  assert.equal(result.size, 0);
});
