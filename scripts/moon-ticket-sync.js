'use strict';

/*
 * Daily sync: scans a local git repo's history for MOON-xxx ticket ids
 * merged to origin/main since the last run, and marks any Product Discovery
 * Sessions feature card tagged with a matching `linkedTicket` (see
 * api/features.js) as complete.
 *
 * Run manually: `node scripts/moon-ticket-sync.js`
 * Run on a schedule: register it with Windows Task Scheduler — see
 * README.md's "Moon ticket sync" section for the exact command.
 *
 * Needs scripts/.env.local (gitignored — copy scripts/.env.local.example
 * and fill in real values; never commit your real password).
 *
 * State (the last commit sha scanned) lives in scripts/.moon-sync-state.json
 * (gitignored, machine-local) so re-runs only look at new commits. On the
 * very first run, with no state file yet, it scans the entire history
 * reachable from origin/main — a card tagged with a ticket that shipped
 * months ago should still get marked complete the first time it's synced.
 *
 * State only advances past commits once the login + feature fetch above it
 * succeeded — a transient network/API failure leaves the range to rescan
 * on the next run rather than silently skipping commits.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const ENV_FILE = path.join(SCRIPT_DIR, '.env.local');
const STATE_FILE = path.join(SCRIPT_DIR, '.moon-sync-state.json');
const LOG_FILE = path.join(SCRIPT_DIR, 'moon-sync.log');
const TICKET_RE = /MOON-\d+/gi;

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

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { lastSyncedSha: null };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { lastSyncedSha: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function git(repoPath, args) {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
}

function findNewTickets(repoPath, lastSyncedSha) {
  if (!fs.existsSync(repoPath)) {
    throw new Error('MOON_REPO_PATH does not exist: ' + repoPath);
  }
  log('Fetching origin/main in ' + repoPath + '...');
  git(repoPath, ['fetch', 'origin', 'main', '--quiet']);
  const headSha = git(repoPath, ['rev-parse', 'origin/main']);

  const range = lastSyncedSha ? lastSyncedSha + '..origin/main' : 'origin/main';
  const messages = git(repoPath, ['log', range, '--pretty=%s']);

  const tickets = new Set();
  (messages.match(TICKET_RE) || []).forEach(function (t) { tickets.add(t.toUpperCase()); });

  return { tickets: tickets, headSha: headSha };
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

async function apiMarkComplete(baseUrl, cookie, featureId) {
  const res = await fetch(baseUrl.replace(/\/$/, '') + '/api/features', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'update', id: featureId, complete: true })
  });
  if (!res.ok) throw new Error('Could not mark feature ' + featureId + ' complete (' + res.status + '): ' + (await res.text()).slice(0, 300));
}

async function main() {
  const env = loadEnv();
  const state = loadState();

  log('Starting Moon ticket sync. Last synced commit: ' + (state.lastSyncedSha || '(none — first run, scanning full history)'));

  const found = findNewTickets(env.MOON_REPO_PATH, state.lastSyncedSha);
  log('Found ' + found.tickets.size + ' ticket id(s) in new commits' + (found.tickets.size ? ': ' + Array.from(found.tickets).join(', ') : '.'));

  if (found.tickets.size === 0) {
    saveState({ lastSyncedSha: found.headSha });
    log('Nothing to match. Done.');
    return;
  }

  log('Logging in to ' + env.PDS_BASE_URL + '...');
  const cookie = await apiLogin(env.PDS_BASE_URL, env.PDS_APP_PASSWORD);

  log('Fetching feature cards...');
  const features = await apiGetFeatures(env.PDS_BASE_URL, cookie);

  const toComplete = features.filter(function (f) {
    return f.linkedTicket && found.tickets.has(String(f.linkedTicket).trim().toUpperCase()) && !f.complete;
  });
  log('Matched ' + toComplete.length + ' card(s) to mark complete.');

  let failed = 0;
  for (const f of toComplete) {
    try {
      await apiMarkComplete(env.PDS_BASE_URL, cookie, f.id);
      log('  Marked complete: ' + f.linkedTicket + ' - "' + f.item + '" (id ' + f.id + ')');
    } catch (err) {
      failed++;
      log('  FAILED to mark complete: ' + f.linkedTicket + ' (id ' + f.id + ') - ' + err.message);
    }
  }

  saveState({ lastSyncedSha: found.headSha });
  log('Done. ' + (toComplete.length - failed) + ' succeeded, ' + failed + ' failed.');
}

main().catch(function (err) {
  log('FATAL: ' + err.message);
  process.exitCode = 1;
});
