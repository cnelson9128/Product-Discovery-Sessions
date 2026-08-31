'use strict';

const store = require('../lib/store');

const NAME_MAX = 200;

/*
 * The managed client roster sessions are tagged against — see lib/store.js's
 * header comment for why this is a small mutable list rather than free text
 * or a hardcoded module-style constant.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
};

async function handleGet(req, res) {
  const items = await store.readClients();
  return res.status(200).json({ items: items.slice().sort(function (a, b) { return a.localeCompare(b); }) });
}

async function handlePost(req, res) {
  if (!store.configured()) {
    return res.status(503).json({
      error: 'No Redis store is linked, so clients cannot be saved. Add an Upstash Redis ' +
        'integration from the Vercel Marketplace, then redeploy.',
      diagnostics: store.diagnostics()
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.action !== 'create') return res.status(400).json({ error: 'Unknown action.' });

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required.' });
  if (name.length > NAME_MAX) return res.status(400).json({ error: 'name is longer than ' + NAME_MAX + ' characters.' });

  const items = await store.addClient(name);
  return res.status(200).json({ ok: true, items: items.slice().sort(function (a, b) { return a.localeCompare(b); }) });
}
