'use strict';

/*
 * Daily sync: keeps Product Discovery Sessions feature cards up to date with
 * what's actually shipped in a separate codebase ("Moon"). Two passes, both
 * reading the same gathered commit data:
 *
 *  1. Explicit ticket match (free, no AI) — a card's `linkedTicket` (e.g.
 *     "MOON-411", see api/features.js) matching a MOON-xxx id mentioned in
 *     any new commit marks it complete via the `autoComplete` action, with
 *     an audit trail (which commit(s), why).
 *  2. Semantic match (lib/moon-match.js, one Claude call) — every other
 *     still-open card is matched against the new commits' messages, changed
 *     files, and a capped diff, to infer whether the card's request has
 *     actually been built even with no ticket id on it. A "high" confidence
 *     match auto-completes the same way as pass 1; "medium"/"low" instead
 *     leaves a confirm-or-dismiss suggestion on the card (`suggestComplete`)
 *     rather than risk marking something complete that isn't — this data
 *     feeds the Sentiment Report and exec reporting.
 *
 * Run manually: `node scripts/moon-ticket-sync.js`
 * Run on a schedule: register it with Windows Task Scheduler — see
 * README.md's "Moon ticket sync" section for the exact command.
 *
 * Needs scripts/.env.local (gitignored — copy scripts/.env.local.example
 * and fill in real values; never commit your real password or API key).
 * ANTHROPIC_API_KEY is optional — without it, pass 2 is skipped entirely and
 * only the free ticket-matching pass runs.
 *
 * State lives in scripts/.moon-sync-state.json (gitignored, machine-local):
 * two independent watermarks, `lastTicketSha` and `lastSemanticSha`, each
 * only advancing past a batch of commits once that pass actually completed
 * for them — so a transient failure in one pass (network, API, rate limit)
 * gets that same commit range retried next run instead of silently
 * skipped, without blocking the other pass's progress. On the very first
 * run, with no state file yet, both scan the entire history reachable from
 * origin/main.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const ENV_FILE = path.join(SCRIPT_DIR, '.env.local');
const STATE_FILE = path.join(SCRIPT_DIR, '.moon-sync-state.json');
const LOG_FILE = path.join(SCRIPT_DIR, 'moon-sync.log');
const TICKET_RE = /MOON-\d+/gi;
const MAX_DIFF_CHARS_PER_COMMIT = 1500;
const MAX_COMMITS_FOR_MATCHING = 60;

function log(line) {
  const stamped = '[' + new Date().toISOString() + '] ' + line;
  console.log(stamped);
  fs.appendFileSync(LOG_FILE, stamped + '\n');
}

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error('Missing ' + ENV_FILE + ' — copy scripts/.env.local.example to scripts/.env.local and fill in your values.');
  }
  const out = {};
  fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('#') === 0) return;
    const eq = trimmed.indexOf('=');
    if (eq < 0) return;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  });
  ['PDS_BASE_URL', 'PDS_APP_PASSWORD', 'MOON_REPO_PATH'].forEach(function (key) {
    if (!out[key]) throw new Error('Missing ' + key + ' in ' + ENV_FILE);
  });
  return out;
}

/* Migrates the older single-watermark shape (from before the semantic pass
   existed) onto today's two-watermark one. Pure, so it's unit-testable
   without touching the filesystem. */
function migrateState(raw) {
  if (!raw) return { lastTicketSha: null, lastSemanticSha: null };
  if (raw.lastSyncedSha !== undefined && raw.lastTicketSha === undefined) {
    return { lastTicketSha: raw.lastSyncedSha, lastSemanticSha: raw.lastSyncedSha };
  }
  return { lastTicketSha: raw.lastTicketSha || null, lastSemanticSha: raw.lastSemanticSha || null };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return migrateState(null);
  try {
    return migrateState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    return migrateState(null);
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function git(repoPath, args) {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 }).trim();
}

/* message/changed-file-stat/capped-diff for one commit — the richest data
   either pass below needs. Exported so a one-off full-history backfill can
   fetch this for an arbitrary list of shas without going through a
   since..HEAD range. */
function gatherOneCommit(repoPath, sha) {
  const message = git(repoPath, ['log', '-1', '--pretty=%s%n%n%b', sha]).trim();
  let files = '';
  let diff = '';
  try { files = git(repoPath, ['show', '--stat', '--format=', sha]).trim(); } catch (e) { /* binary/merge weirdness — not fatal */ }
  try { diff = git(repoPath, ['show', '--format=', sha]).slice(0, MAX_DIFF_CHARS_PER_COMMIT); } catch (e) { /* same */ }
  return { sha: sha, message: message, files: files, diff: diff };
}

/* Gathers every commit reachable from origin/main since `sinceSha` (or the
   entire history if null), each with its message, changed-file stat, and a
   capped diff. One git fetch + one pass of `git show` per commit. `git log`
   lists newest-first, so `commits[0]` is the most recent commit in range —
   callers that cap the list (see runSemanticPass) must slice from the
   front, not the back, to keep the most recent ones. */
function gatherCommits(repoPath, sinceSha) {
  if (!fs.existsSync(repoPath)) {
    throw new Error('MOON_REPO_PATH does not exist: ' + repoPath);
  }
  log('Fetching origin/main in ' + repoPath + '...');
  git(repoPath, ['fetch', 'origin', 'main', '--quiet']);
  const headSha = git(repoPath, ['rev-parse', 'origin/main']);

  const range = sinceSha ? sinceSha + '..origin/main' : 'origin/main';
  const shaList = git(repoPath, ['log', range, '--pretty=%H']).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);

  const commits = shaList.map(function (sha) { return gatherOneCommit(repoPath, sha); });

  return { commits: commits, headSha: headSha };
}

/* {ticket -> Set<sha>} across every gathered commit's message — cheap regex,
   runs over the full commit list regardless of MAX_COMMITS_FOR_MATCHING,
   since this pass doesn't touch the model at all. */
function extractTicketShas(commits) {
  const ticketShas = new Map();
  commits.forEach(function (c) {
    const found = c.message.match(TICKET_RE) || [];
    found.forEach(function (t) {
      const key = t.toUpperCase();
      if (!ticketShas.has(key)) ticketShas.set(key, new Set());
      ticketShas.get(key).add(c.sha);
    });
  });
  return ticketShas;
}

async function apiLogin(baseUrl, password) {
  const res = await fetch(baseUrl.replace(/\/$/, '') + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: password })
  });
  if (!res.ok) throw new Error('Login failed (' + res.status + '): ' + (await res.text()).slice(0, 300));
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('Login succeeded but no session cookie was returned.');
  return setCookie.split(';')[0];
}

async function apiGetFeatures(baseUrl, cookie) {
  const res = await fetch(baseUrl.replace(/\/$/, '') + '/api/features', {
    headers: { Cookie: cookie }
  });
  if (!res.ok) throw new Error('Could not fetch features (' + res.status + '): ' + (await res.text()).slice(0, 300));
  const body = await res.json();
  return body.items || [];
}

async function apiAction(baseUrl, cookie, body) {
  const res = await fetch(baseUrl.replace(/\/$/, '') + '/api/features', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('action ' + body.action + ' on ' + body.id + ' failed (' + res.status + '): ' + (await res.text()).slice(0, 300));
}

async function runTicketPass(env, cookie, features, ticketShas) {
  if (ticketShas.size === 0) {
    log('Ticket pass: no MOON-xxx ids in the new commits.');
    return { handledIds: new Set(), succeeded: 0, failed: 0 };
  }
  log('Ticket pass: found ' + ticketShas.size + ' ticket id(s): ' + Array.from(ticketShas.keys()).join(', '));

  const toComplete = features.filter(function (f) {
    return f.linkedTicket && ticketShas.has(String(f.linkedTicket).trim().toUpperCase()) && !f.complete;
  });
  log('Ticket pass: matched ' + toComplete.length + ' card(s).');

  const handledIds = new Set();
  let succeeded = 0, failed = 0;
  for (const f of toComplete) {
    const ticket = String(f.linkedTicket).trim().toUpperCase();
    const shas = Array.from(ticketShas.get(ticket) || []);
    try {
      await apiAction(env.PDS_BASE_URL, cookie, {
        action: 'autoComplete', id: f.id,
        reason: 'Linked ticket ' + f.linkedTicket + ' appears in a commit on origin/main.',
        commitShas: shas
      });
      log('  Auto-completed: ' + f.linkedTicket + ' - "' + f.item + '" (id ' + f.id + ')');
      handledIds.add(f.id);
      succeeded++;
    } catch (err) {
      failed++;
      log('  FAILED to auto-complete: ' + f.linkedTicket + ' (id ' + f.id + ') - ' + err.message);
    }
  }
  return { handledIds: handledIds, succeeded: succeeded, failed: failed };
}

async function runSemanticPass(env, cookie, features, commits, alreadyHandledIds) {
  if (!env.ANTHROPIC_API_KEY) {
    log('Semantic pass: skipped — no ANTHROPIC_API_KEY set in .env.local.');
    return { ran: false, succeeded: 0, failed: 0 };
  }
  if (!commits.length) {
    log('Semantic pass: no new commits to check.');
    return { ran: true, succeeded: 0, failed: 0 };
  }

  const openCards = features
    .filter(function (f) { return !f.complete && !alreadyHandledIds.has(f.id); })
    .map(function (f) { return { id: f.id, module: f.module, item: f.item, rationale: f.rationale }; });

  if (!openCards.length) {
    log('Semantic pass: no open cards left to check against.');
    return { ran: true, succeeded: 0, failed: 0 };
  }

  let commitsForMatching = commits;
  if (commits.length > MAX_COMMITS_FOR_MATCHING) {
    log('Semantic pass: ' + commits.length + ' new commits exceeds the per-run cap of ' + MAX_COMMITS_FOR_MATCHING +
      ' — only the ' + MAX_COMMITS_FOR_MATCHING + ' most recent are sent for matching this run (ticket matching above still covered all of them).');
    commitsForMatching = commits.slice(0, MAX_COMMITS_FOR_MATCHING);
  }

  process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  const moonMatch = require('../lib/moon-match');

  log('Semantic pass: matching ' + openCards.length + ' open card(s) against ' + commitsForMatching.length + ' commit(s)...');
  const matches = moonMatch ? await moonMatch.matchCommitsToCards(
    openCards,
    commitsForMatching.map(function (c) { return { sha: c.sha, message: c.message, files: c.files, diff: c.diff }; })
  ) : [];
  log('Semantic pass: model returned ' + matches.length + ' match(es).');

  let succeeded = 0, failed = 0;
  for (const m of matches) {
    const feature = features.find(function (f) { return f.id === m.feature_card_id; });
    if (!feature) { log('  Ignoring match for unknown card id ' + m.feature_card_id); continue; }
    try {
      if (m.confidence === 'high') {
        await apiAction(env.PDS_BASE_URL, cookie, {
          action: 'autoComplete', id: feature.id, reason: m.reason, commitShas: m.evidence_commit_shas
        });
        log('  Auto-completed (high confidence): "' + feature.item + '" (id ' + feature.id + ') — ' + m.reason);
      } else {
        await apiAction(env.PDS_BASE_URL, cookie, {
          action: 'suggestComplete', id: feature.id, confidence: m.confidence, reason: m.reason, commitShas: m.evidence_commit_shas
        });
        log('  Suggested (' + m.confidence + ' confidence): "' + feature.item + '" (id ' + feature.id + ') — ' + m.reason);
      }
      succeeded++;
    } catch (err) {
      failed++;
      log('  FAILED to record match for ' + feature.id + ' - ' + err.message);
    }
  }
  return { ran: true, succeeded: succeeded, failed: failed };
}

async function main() {
  const env = loadEnv();
  const state = loadState();
  const rangeStart = state.lastSemanticSha || state.lastTicketSha || null;

  log('Starting Moon sync. Ticket watermark: ' + (state.lastTicketSha || '(none)') + ', semantic watermark: ' + (state.lastSemanticSha || '(none — full history)'));

  const gathered = gatherCommits(env.MOON_REPO_PATH, rangeStart);
  log('Gathered ' + gathered.commits.length + ' new commit(s) up to ' + gathered.headSha.slice(0, 10) + '.');

  if (!gathered.commits.length) {
    saveState({ lastTicketSha: gathered.headSha, lastSemanticSha: gathered.headSha });
    log('Nothing new. Done.');
    return;
  }

  log('Logging in to ' + env.PDS_BASE_URL + '...');
  const cookie = await apiLogin(env.PDS_BASE_URL, env.PDS_APP_PASSWORD);

  log('Fetching feature cards...');
  const features = await apiGetFeatures(env.PDS_BASE_URL, cookie);

  const ticketShas = extractTicketShas(gathered.commits);
  const ticketResult = await runTicketPass(env, cookie, features, ticketShas);
  state.lastTicketSha = gathered.headSha;

  let semanticResult = { ran: false, succeeded: 0, failed: 0 };
  try {
    semanticResult = await runSemanticPass(env, cookie, features, gathered.commits, ticketResult.handledIds);
    state.lastSemanticSha = gathered.headSha;
  } catch (err) {
    log('Semantic pass FAILED, will retry this commit range next run: ' + err.message);
  }

  saveState(state);
  log('Done. Ticket pass: ' + ticketResult.succeeded + ' succeeded, ' + ticketResult.failed + ' failed. ' +
    'Semantic pass: ' + (semanticResult.ran ? semanticResult.succeeded + ' succeeded, ' + semanticResult.failed + ' failed.' : 'did not run.'));
}

if (require.main === module) {
  main().catch(function (err) {
    log('FATAL: ' + err.message);
    process.exitCode = 1;
  });
}

/* Exported in full (not just the pure helpers) so a smoke test can compose
   gatherCommits/runTicketPass/runSemanticPass itself against a throwaway git
   repo and a local fake of the features API, without main()'s hardcoded
   reads of the real scripts/.env.local, state file, and log file on disk. */
module.exports = {
  migrateState, extractTicketShas, MAX_COMMITS_FOR_MATCHING,
  gatherCommits, gatherOneCommit, apiLogin, apiGetFeatures, apiAction, runTicketPass, runSemanticPass
};
