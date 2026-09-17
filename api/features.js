'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');
const trendCards = require('../lib/trend-cards');

const OWNER_MAX = 200;

/*
 * CRUD surface for roadmap features (see lib/store.js's "roadmap features"
 * section for why these live in one flat pds:feature:index rather than a
 * session-style index+detail split). Any signed-in session can read and
 * write here — one shared password, no roles, same as every other endpoint.
 *
 * `item`/`rationale`/`supporting_session_ids` are model-authored and
 * evidence-linked — they are never accepted by the update allow-list below.
 * Only `bucket`, `module` (moving a feature between modules), `owner`,
 * `complete`, and `requirementsDone` are user-editable.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
};

function queryModule(req) {
  /* Vercel's Node runtime populates req.query, but parse req.url directly
     too as a fallback — cheap, and removes any dependency on that runtime
     detail holding true. */
  if (req.query && req.query.module) return req.query.module;
  try {
    return new URL(req.url, 'http://x').searchParams.get('module');
  } catch (e) {
    return null;
  }
}

async function handleGet(req, res) {
  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  const moduleId = queryModule(req);
  const items = await store.readFeatureIndex();

  if (moduleId) {
    if (!modules.isValidModule(moduleId)) return res.status(400).json({ error: 'Unknown module.' });
    return res.status(200).json({ items: items.filter(function (f) { return f.module === moduleId; }) });
  }

  return res.status(200).json({ items: items });
}

/* Returns {out, errors} — `out` holds only the fields actually present and
   valid in `body`, so a caller can Object.assign it onto an existing record
   without clobbering fields it didn't mention. */
function validatePatch(body) {
  const errors = [];
  const out = {};
  let any = false;

  if (body.bucket !== undefined) {
    any = true;
    if (typeof body.bucket !== 'string' || !trendCards.isValidBucket(body.bucket)) {
      errors.push('bucket must be one of: ' + trendCards.BUCKETS.join(', '));
    } else {
      out.bucket = body.bucket;
    }
  }

  if (body.module !== undefined) {
    any = true;
    if (typeof body.module !== 'string' || !modules.isValidModule(body.module)) {
      errors.push('module must be one of the known modules.');
    } else {
      out.module = body.module;
    }
  }

  if (body.owner !== undefined) {
    any = true;
    if (typeof body.owner !== 'string') {
      errors.push('owner must be text.');
    } else if (body.owner.length > OWNER_MAX) {
      errors.push('owner is longer than ' + OWNER_MAX + ' characters.');
    } else {
      out.owner = body.owner.trim();
    }
  }

  if (body.complete !== undefined) {
    any = true;
    if (typeof body.complete !== 'boolean') errors.push('complete must be true or false.');
    else out.complete = body.complete;
  }

  if (body.requirementsDone !== undefined) {
    any = true;
    if (typeof body.requirementsDone !== 'boolean') errors.push('requirementsDone must be true or false.');
    else out.requirementsDone = body.requirementsDone;
  }

  if (!any) errors.push('Nothing to update.');
  return { out: out, errors: errors };
}

async function handlePost(req, res) {
  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  if (!store.configured()) {
    return res.status(503).json({
      error: 'No Redis store is linked, so features cannot be saved. Add an Upstash Redis ' +
        'integration from the Vercel Marketplace, then redeploy.',
      diagnostics: store.diagnostics()
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.id !== 'string') return res.status(400).json({ error: 'id is required.' });

  if (body.action === 'delete') {
    const items = await store.readFeatureIndex();
    await store.writeFeatureIndex(items.filter(function (f) { return f.id !== body.id; }));
    return res.status(200).json({ ok: true, id: body.id, deleted: true });
  }

  if (body.action === 'update') {
    const items = await store.readFeatureIndex();
    const feature = items.find(function (f) { return f.id === body.id; });
    if (!feature) return res.status(404).json({ error: 'No feature with that id.' });

    const patch = validatePatch(body);
    if (patch.errors.length) return res.status(400).json({ error: patch.errors.join(' ') });

    Object.assign(feature, patch.out, { updatedAt: new Date().toISOString() });
    await store.writeFeatureIndex(items);
    return res.status(200).json({ ok: true, item: feature });
  }

  return res.status(400).json({ error: 'Unknown action.' });
}
