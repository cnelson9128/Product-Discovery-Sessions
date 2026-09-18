'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');
const buckets = require('../lib/buckets');
const moduleClassification = require('../lib/module-classification');

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
 *
 * A `module` change here is always a manual override: it sets
 * `isManualModule`, which tells lib/feature-sync.js to stop touching this
 * card's module/secondaryModules/confidence/classificationReason on future
 * syncs, and appends `{at, from, to}` to `moduleHistory` — this app has no
 * per-user identity (one shared password, no roles), so "who" isn't
 * recorded, only when and between which two modules. The `resetClassification`
 * action below is how a human hands a card back to the parser.
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
    if (typeof body.bucket !== 'string' || !buckets.isValidBucket(body.bucket)) {
      errors.push('bucket must be one of: ' + buckets.BUCKETS.join(', '));
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

/* Pure — no store access, so this is what tests exercise directly. Given a
   validated patch and the feature it'll be applied to, returns the fields to
   actually merge: unchanged unless the patch moves `module`, in which case it
   adds the manual-override flag and audit-trail entry. */
function applyPatch(feature, patchOut) {
  const out = Object.assign({}, patchOut);
  if (out.module !== undefined && out.module !== feature.module) {
    const history = Array.isArray(feature.moduleHistory) ? feature.moduleHistory.slice() : [];
    history.push({ at: new Date().toISOString(), from: feature.module, to: out.module });
    out.moduleHistory = history;
    out.isManualModule = true;
  }
  return out;
}

/* Pure — maps a classification result (from a session's stored raisedItems
   entry, or from moduleClassification.classifyExistingItems) onto the
   feature-record field names. Both sources share the same
   primary_module/secondary_modules/confidence/classification_reason shape
   (lib/module-classification.js's CLASSIFICATION_FIELDS). */
function toRestoredFields(classified) {
  return {
    module: classified.primary_module,
    secondaryModules: classified.secondary_modules || [],
    confidence: classified.confidence,
    classificationReason: classified.classification_reason
  };
}

/* Pure — the audit-trail entry a resetClassification produces, only if it
   actually changes the module. */
function historyForRestore(feature, restored) {
  const history = Array.isArray(feature.moduleHistory) ? feature.moduleHistory.slice() : [];
  if (restored.module !== feature.module) {
    history.push({ at: new Date().toISOString(), from: feature.module, to: restored.module });
  }
  return history;
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

    Object.assign(feature, applyPatch(feature, patch.out), { updatedAt: new Date().toISOString() });
    await store.writeFeatureIndex(items);
    return res.status(200).json({ ok: true, item: feature });
  }

  if (body.action === 'resetClassification') {
    const items = await store.readFeatureIndex();
    const feature = items.find(function (f) { return f.id === body.id; });
    if (!feature) return res.status(404).json({ error: 'No feature with that id.' });

    let restored = null;

    /* Prefer recomputing from the exact extracted item this card came from —
       already classified once, no LLM call needed. Falls back to the
       standalone reclassifier only for legacy cards with no such link. */
    if (feature.sourceSessionId && feature.sourceItemKey) {
      const originSession = await store.readSession(feature.sourceSessionId);
      const itemIndex = Number(feature.sourceItemKey.split('#').pop());
      const raised = originSession && Array.isArray(originSession.raisedItems)
        ? originSession.raisedItems[itemIndex]
        : null;
      if (raised) restored = toRestoredFields(raised);
    }

    if (!restored) {
      try {
        const classified = await moduleClassification.classifyExistingItems([
          { key: feature.id, item: feature.item, rationale: feature.rationale }
        ]);
        const c = classified[0];
        if (!c) throw new Error('The classifier returned no result.');
        restored = toRestoredFields(c);
      } catch (err) {
        const reason = (err && err.message) || 'unknown error';
        const status = err && err.code === 'NO_API_KEY' ? 503 : 502;
        return res.status(status).json({ error: 'Could not reclassify this card: ' + reason + '.' });
      }
    }

    Object.assign(feature, restored, {
      moduleHistory: historyForRestore(feature, restored),
      isManualModule: false,
      updatedAt: new Date().toISOString()
    });
    await store.writeFeatureIndex(items);
    return res.status(200).json({ ok: true, item: feature });
  }

  return res.status(400).json({ error: 'Unknown action.' });
}

/* Attached to the default export (still a callable handler function, which
   is all Vercel's Node runtime requires) so test/features-api.test.js can
   exercise the pure validation/patch logic without a store. */
module.exports.validatePatch = validatePatch;
module.exports.applyPatch = applyPatch;
module.exports.toRestoredFields = toRestoredFields;
module.exports.historyForRestore = historyForRestore;
