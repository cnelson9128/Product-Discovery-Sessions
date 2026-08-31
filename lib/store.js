'use strict';

/*
 * Persistence over the Upstash Redis REST API.
 *
 * Vercel KV was sunset — existing stores were moved to Upstash Redis in
 * December 2024, and new projects install a Redis provider from the Vercel
 * Marketplace. The wire protocol is unchanged, so the only thing that varies
 * is which environment variable names get injected. Rather than make the
 * operator rename anything, we accept every name pair in circulation:
 *
 *   KV_REST_API_URL       / KV_REST_API_TOKEN        (Vercel KV, and the
 *                                                     compatibility aliases
 *                                                     Upstash still sets)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash native)
 *   REDIS_REST_URL         / REDIS_REST_TOKEN         (some other providers)
 *
 * Deliberately uses plain fetch rather than a client package: this repo has no
 * build step, and a dependency tree to store a handful of small records would
 * be a poor trade. Note this needs an HTTP/REST Redis — a TCP-only provider
 * will not work without a driver.
 *
 * There is no in-memory fallback on purpose. A fallback would let the UI
 * report a successful save that silently vanishes on the next cold start;
 * callers get an explicit "not configured" error instead.
 */

const CREDENTIAL_PAIRS = [
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ['REDIS_REST_URL', 'REDIS_REST_TOKEN']
];

/* Returns {url, token, via} for the first complete pair, else null. */
function credentials() {
  for (const [urlVar, tokenVar] of CREDENTIAL_PAIRS) {
    const url = process.env[urlVar];
    const token = process.env[tokenVar];
    if (url && token) return { url: url, token: token, via: urlVar };
  }
  return null;
}

function configured() {
  return credentials() !== null;
}

/* Names only — never values. Lets the UI say precisely what is missing
   instead of an unhelpful "storage not configured". */
function diagnostics() {
  const found = credentials();
  return {
    configured: found !== null,
    usingPair: found ? found.via : null,
    accepts: CREDENTIAL_PAIRS.map(function (p) { return p[0] + ' + ' + p[1]; }),
    present: CREDENTIAL_PAIRS.reduce(function (acc, p) {
      if (process.env[p[0]]) acc.push(p[0]);
      if (process.env[p[1]]) acc.push(p[1]);
      return acc;
    }, [])
  };
}

async function command(args) {
  const creds = credentials();
  if (!creds) {
    const err = new Error('Storage is not configured');
    err.code = 'KV_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(creds.url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + creds.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) {
    throw new Error('KV request failed (' + res.status + '): ' + (await res.text()));
  }
  const body = await res.json();
  return body.result;
}

async function getJSON(key, fallback) {
  const raw = await command(['GET', key]);
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

async function setJSON(key, value) {
  return command(['SET', key, JSON.stringify(value)]);
}

/* ---- discovery sessions ----
   Two keys, not one blob: transcripts can run to tens of thousands of
   characters, and a dashboard that had to read every transcript just to list
   rows would only get slower as the team logs more sessions. `SESSION_INDEX_KEY`
   holds lightweight metadata only (no transcript, no analysis) for the
   dashboard table; each session's full record — metadata plus transcript plus
   generated analysis — lives at its own key, fetched only when that session's
   detail view is opened. */

const SESSION_INDEX_KEY = 'pds:session:index';

function sessionKey(id) {
  return 'pds:session:' + id;
}

async function readSessionIndex() {
  if (!configured()) return [];
  return (await getJSON(SESSION_INDEX_KEY, [])) || [];
}

async function writeSessionIndex(list) {
  await setJSON(SESSION_INDEX_KEY, list);
}

async function readSession(id) {
  if (!configured()) return null;
  return getJSON(sessionKey(id), null);
}

async function writeSession(id, record) {
  await setJSON(sessionKey(id), record);
}

async function deleteSession(id) {
  const index = await readSessionIndex();
  await writeSessionIndex(index.filter(function (s) { return s.id !== id; }));
  try {
    await command(['DEL', sessionKey(id)]);
  } catch (e) {
    /* index entry is already gone; an orphaned full record is harmless */
  }
}

/* ---- managed client list ----
   ~10 clients, each reused across many sessions, so this is a small managed
   list rather than free text — the same "don't let typos fragment the data"
   reasoning as the fixed module list, except the roster can genuinely grow
   mid-program if a new client joins the research, so it lives in Redis
   rather than a hardcoded module like lib/modules.js. */

const CLIENTS_KEY = 'pds:clients';

async function readClients() {
  if (!configured()) return [];
  return (await getJSON(CLIENTS_KEY, [])) || [];
}

async function addClient(name) {
  const clients = await readClients();
  const exists = clients.some(function (c) { return c.toLowerCase() === name.toLowerCase(); });
  if (!exists) {
    clients.push(name);
    await setJSON(CLIENTS_KEY, clients);
  }
  return clients;
}

/* ---- module trends ----
   One record per module, holding the last synthesis run over every ready
   session tagged to it. Staleness is computed by the caller (diffing
   builtFromSessionIds against the live index), not stored here — that way
   it's always correct against the current session set with no separate
   invalidation step to remember. */

function trendKey(moduleId) {
  return 'pds:trend:' + moduleId;
}

async function readModuleTrend(moduleId) {
  if (!configured()) return null;
  return getJSON(trendKey(moduleId), null);
}

async function writeModuleTrend(moduleId, record) {
  await setJSON(trendKey(moduleId), record);
}

/* All trend records, with the (potentially large) `result` field stripped —
   for the Modules overview page, which only needs build metadata to render
   staleness badges for all modules in one request. */
async function readAllModuleTrendSummaries(moduleIds) {
  if (!configured()) return {};
  const out = {};
  for (const id of moduleIds) {
    const record = await readModuleTrend(id);
    out[id] = record
      ? Object.assign({}, record, { result: undefined })
      : null;
  }
  return out;
}

module.exports = {
  configured,
  diagnostics,
  readSessionIndex,
  writeSessionIndex,
  readSession,
  writeSession,
  deleteSession,
  readClients,
  addClient,
  readModuleTrend,
  writeModuleTrend,
  readAllModuleTrendSummaries,
  SESSION_INDEX_KEY,
  CLIENTS_KEY
};
