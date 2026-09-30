'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const batches = require('../lib/batches');

const NAME_MAX = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CLIENTS_PER_BATCH = 2;

/*
 * The 8 migration batches are fixed (lib/batches.js); this endpoint is the
 * editable half — each batch's locked client roster and target migration
 * date, both real-world facts that can change (a client swaps out, a date
 * slips). Any signed-in session can read and write here — one shared
 * password, no roles, same as every other endpoint.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
};

async function handleGet(req, res) {
  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  const roster = await store.readMigrationRoster();
  const items = batches.BATCHES.map(function (b) {
    const entry = roster[b.id] || {};
    return {
      id: b.id,
      label: b.label,
      description: b.description,
      clients: Array.isArray(entry.clients) ? entry.clients : [],
      targetDate: entry.targetDate || null
    };
  });
  return res.status(200).json({ items: items });
}

/* Pure — no store access — exported for test/migration-batches-api.test.js.
   Returns {out, errors}; `out` holds only the fields actually present and
   valid in `body`, same shape as api/features.js's validatePatch. */
function validateRosterPatch(body) {
  const errors = [];
  const out = {};
  let any = false;

  if (body.clients !== undefined) {
    any = true;
    if (!Array.isArray(body.clients)) {
      errors.push('clients must be an array of names.');
    } else if (body.clients.length > MAX_CLIENTS_PER_BATCH) {
      errors.push('clients cannot have more than ' + MAX_CLIENTS_PER_BATCH + ' entries.');
    } else if (!body.clients.every(function (c) { return typeof c === 'string'; })) {
      errors.push('each client must be text.');
    } else if (body.clients.some(function (c) { return c.length > NAME_MAX; })) {
      errors.push('a client name is longer than ' + NAME_MAX + ' characters.');
    } else {
      out.clients = body.clients.map(function (c) { return c.trim(); });
    }
  }

  if (body.targetDate !== undefined) {
    any = true;
    if (body.targetDate === null || body.targetDate === '') {
      out.targetDate = null;
    } else if (typeof body.targetDate !== 'string' || !DATE_RE.test(body.targetDate)) {
      errors.push('targetDate must be in YYYY-MM-DD format, or null to clear it.');
    } else {
      out.targetDate = body.targetDate;
    }
  }

  if (!any) errors.push('Nothing to update.');
  return { out: out, errors: errors };
}

async function handlePost(req, res) {
  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  if (!store.configured()) {
    return res.status(503).json({
      error: 'No Redis store is linked, so the roster cannot be saved. Add an Upstash Redis ' +
        'integration from the Vercel Marketplace, then redeploy.',
      diagnostics: store.diagnostics()
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.action !== 'update') return res.status(400).json({ error: 'Unknown action.' });
  if (typeof body.batchId !== 'string' || !batches.isValidBatch(body.batchId)) {
    return res.status(400).json({ error: 'batchId is required and must be one of the known migration batches.' });
  }

  const patch = validateRosterPatch(body);
  if (patch.errors.length) return res.status(400).json({ error: patch.errors.join(' ') });

  const roster = await store.readMigrationRoster();
  const existing = roster[body.batchId] || { clients: [], targetDate: null };
  roster[body.batchId] = Object.assign({}, existing, patch.out);
  await store.writeMigrationRoster(roster);

  const b = batches.BATCHES.find(function (x) { return x.id === body.batchId; });
  return res.status(200).json({
    ok: true,
    item: {
      id: b.id,
      label: b.label,
      description: b.description,
      clients: roster[body.batchId].clients || [],
      targetDate: roster[body.batchId].targetDate || null
    }
  });
}

module.exports.validateRosterPatch = validateRosterPatch;
