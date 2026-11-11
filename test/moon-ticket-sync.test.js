'use strict';

const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../scripts/moon-ticket-sync');
const { migrateState, extractTicketShas, runSemanticPass, MAX_COMMITS_FOR_MATCHING } = sync;

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

test('runSemanticPass caps an oversized commit list to the FRONT of the array (the most recent commits, since git log lists newest-first), not the back', async function () {
  const moonMatchPath = require.resolve(path.join(__dirname, '..', 'lib', 'moon-match.js'));
  const originalCacheEntry = require.cache[moonMatchPath];
  let seenCommits = null;
  require.cache[moonMatchPath] = {
    id: moonMatchPath, filename: moonMatchPath, loaded: true,
    exports: {
      CONFIDENCE_LEVELS: ['high', 'medium', 'low'],
      matchCommitsToCards: async function (openCards, commits) { seenCommits = commits; return []; }
    }
  };

  try {
    const commits = [];
    for (let i = 0; i < MAX_COMMITS_FOR_MATCHING + 10; i++) commits.push({ sha: 's' + i, message: 'm' + i, files: '', diff: '' });
    const features = [{ id: 'f1', module: 'search-match', item: 'x', rationale: 'y', complete: false }];

    await runSemanticPass({ ANTHROPIC_API_KEY: 'fake' }, 'cookie', features, commits, new Set());

    assert.equal(seenCommits.length, MAX_COMMITS_FOR_MATCHING);
    assert.equal(seenCommits[0].sha, 's0', 'kept the newest (front-most) commit');
    assert.equal(seenCommits[seenCommits.length - 1].sha, 's' + (MAX_COMMITS_FOR_MATCHING - 1), 'dropped the oldest (back) commits beyond the cap');
  } finally {
    if (originalCacheEntry) require.cache[moonMatchPath] = originalCacheEntry;
    else delete require.cache[moonMatchPath];
  }
});
