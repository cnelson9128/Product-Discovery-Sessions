'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../scripts/moon-ticket-sync');
const { migrateState, extractTicketShas, runSemanticPass, gatherDiffSample, MAX_COMMITS_FOR_MATCHING, MAX_DIFF_CHARS_PER_COMMIT } = sync;

function makeTestRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-sync-unit-'));
  const git = function (args) { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }); };
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@test.local']);
  git(['config', 'user.name', 'Test']);
  return { dir: dir, git: git };
}

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

test('gatherDiffSample spreads its budget across multiple changed files instead of exhausting it on the first one', function () {
  const repo = makeTestRepo();
  try {
    fs.writeFileSync(path.join(repo.dir, 'a.txt'), 'x'.repeat(5000));
    fs.writeFileSync(path.join(repo.dir, 'b.txt'), 'y'.repeat(5000));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'two big files', '--quiet']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();

    const diff = gatherDiffSample(repo.dir, sha);
    assert.ok(diff.length <= MAX_DIFF_CHARS_PER_COMMIT, 'total diff respects the per-commit cap');
    assert.ok(diff.includes('a.txt') || /x{10,}/.test(diff), 'a.txt is represented');
    assert.ok(diff.includes('b.txt') || /y{10,}/.test(diff), 'b.txt is represented too, not just the first file');
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('gatherDiffSample deprioritizes test files in favor of production files when both changed', function () {
  const repo = makeTestRepo();
  try {
    fs.mkdirSync(path.join(repo.dir, '__tests__'));
    fs.writeFileSync(path.join(repo.dir, '__tests__', 'widget.test.ts'), 'TESTMARKERCONTENT'.repeat(300));
    fs.writeFileSync(path.join(repo.dir, 'widget.ts'), 'PRODMARKERCONTENT'.repeat(300));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'widget plus its test', '--quiet']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();

    const diff = gatherDiffSample(repo.dir, sha);
    assert.ok(diff.includes('PRODMARKERCONTENT'), 'production file content is included');
    assert.ok(!diff.includes('TESTMARKERCONTENT'), 'test file is skipped while a production file exists');
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('gatherDiffSample falls back to test files when a commit touches nothing else', function () {
  const repo = makeTestRepo();
  try {
    fs.mkdirSync(path.join(repo.dir, '__tests__'));
    fs.writeFileSync(path.join(repo.dir, '__tests__', 'widget.test.ts'), 'ONLYTESTCONTENT'.repeat(300));
    repo.git(['add', '.']);
    repo.git(['commit', '-m', 'test-only commit', '--quiet']);
    const sha = repo.git(['rev-parse', 'HEAD']).trim();

    const diff = gatherDiffSample(repo.dir, sha);
    assert.ok(diff.includes('ONLYTESTCONTENT'), 'falls back to the test file rather than returning nothing');
  } finally {
    fs.rmSync(repo.dir, { recursive: true, force: true });
  }
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
