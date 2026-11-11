'use strict';

const crypto = require('crypto');
const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');
const buckets = require('../lib/buckets');
const moduleClassification = require('../lib/module-classification');
const moonMatch = require('../lib/moon-match');

const OWNER_MAX = 200;
const LINKED_TICKET_MAX = 50;
const REASON_MAX = 500;
const MAX_COMMIT_SHAS = 20;
const SHA_MAX = 64;
const EPIC_TITLE_MAX = 120;
const EPIC_BULLET_TEXT_MAX = 220;
const EPIC_MAX_BULLETS = 25;
const EPIC_MAX_FEATURE_IDS_PER_BULLET = 20;

/*
 * CRUD surface for roadmap features (see lib/store.js's "roadmap features"
 * section for why these live in one flat pds:feature:index rather than a
 * session-style index+detail split). Any signed-in session can read and
 * write here — one shared password, no roles, same as every other endpoint.
 *
 * `item`/`rationale`/`supporting_session_ids` are model-authored and
 * evidence-linked — they are never accepted by the update allow-list below.
 * Only `bucket`, `module` (moving a feature between modules), `owner`,
 * `complete`, `requirementsDone`, and `linkedTicket` (e.g. a Jira ticket id
 * like "MOON-411" — set by hand so an external sync script can later mark
 * this card complete when that ticket ships) are user-editable.
 *
 * A `module` change here is always a manual override: it sets
 * `isManualModule`, which tells lib/feature-sync.js to stop touching this
 * card's module/secondaryModules/confidence/classificationReason on future
 * syncs, and appends `{at, from, to}` to `moduleHistory` — this app has no
 * per-user identity (one shared password, no roles), so "who" isn't
 * recorded, only when and between which two modules. The `resetClassification`
 * action below is how a human hands a card back to the parser.
 *
 * `suggestComplete`/`autoComplete`/`dismissSuggestion` are for
 * scripts/moon-ticket-sync.js's semantic matching pass (lib/moon-match.js):
 * a high-confidence match marks a card complete directly (`autoComplete`,
 * leaving an `autoCompletedFrom` audit trail — which commit(s), why); a
 * medium/low-confidence match instead sets `autoCompleteSuggestion` so a
 * human can confirm it (the existing `update {complete:true}` action, which
 * already clears any pending suggestion) or dismiss it outright.
 *
 * `createEpic`/`updateEpic` manage epics — a second kind of record in this
 * same flat index (`isEpic: true`), used to fold a pile of near-duplicate
 * per-session cards into one board entry with curated bullets (one per
 * distinct required capability). A bullet cites the original cards it was
 * synthesized from (`bulletsById.featureIds`), which get `epicId` set so the
 * board hides them as standalone cards without deleting them or breaking
 * lib/feature-sync.js's per-session round-trip. The generic `delete` action
 * is epic-aware: deleting an epic ungroups its members instead of orphaning
 * their `epicId`.
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

  if (body.linkedTicket !== undefined) {
    any = true;
    if (typeof body.linkedTicket !== 'string') {
      errors.push('linkedTicket must be text.');
    } else if (body.linkedTicket.length > LINKED_TICKET_MAX) {
      errors.push('linkedTicket is longer than ' + LINKED_TICKET_MAX + ' characters.');
    } else {
      out.linkedTicket = body.linkedTicket.trim();
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
   actually merge: unchanged unless the patch moves `module` (adds the
   manual-override flag and audit-trail entry), or marks the feature
   `complete` (a feature can't be complete without its requirements already
   having been done, so completing one also marks requirementsDone — a
   one-way rule: reopening a completed feature does not un-mark it, since
   the requirements genuinely were done at some point — and clears any
   pending autoCompleteSuggestion, since a human confirming via the normal
   complete action moots whatever prompted the suggestion). */
function applyPatch(feature, patchOut) {
  const out = Object.assign({}, patchOut);
  if (out.module !== undefined && out.module !== feature.module) {
    const history = Array.isArray(feature.moduleHistory) ? feature.moduleHistory.slice() : [];
    history.push({ at: new Date().toISOString(), from: feature.module, to: out.module });
    out.moduleHistory = history;
    out.isManualModule = true;
    /* An epic and its member cards always share one module (see the
       "Epics" README section) — the GET ?module= filter and the board's
       per-module fetch both key on it. Moving a grouped card to a
       different module would otherwise strand it: invisible on both
       boards, since it'd carry epicId into a module its epic was never
       fetched for. Moving it back out of its epic is exactly what a
       manual module override should do here, same as it already does for
       classification. */
    if (feature.epicId) out.epicId = null;
  }
  if (out.complete === true) {
    out.requirementsDone = true;
    out.autoCompleteSuggestion = null;
  }
  return out;
}

/* Pure — shared shape between suggestComplete (needs a confidence level)
   and autoComplete (doesn't — calling it at all means the script already
   decided this is high confidence). Both need a human-readable reason and
   at least one evidence commit sha. */
function validateEvidence(body, opts) {
  const errors = [];
  const out = {};

  if (typeof body.reason !== 'string' || !body.reason.trim()) {
    errors.push('reason is required.');
  } else if (body.reason.length > REASON_MAX) {
    errors.push('reason is longer than ' + REASON_MAX + ' characters.');
  } else {
    out.reason = body.reason.trim();
  }

  if (!Array.isArray(body.commitShas) || !body.commitShas.length) {
    errors.push('commitShas must be a non-empty array.');
  } else if (body.commitShas.length > MAX_COMMIT_SHAS) {
    errors.push('commitShas cannot have more than ' + MAX_COMMIT_SHAS + ' entries.');
  } else if (!body.commitShas.every(function (s) { return typeof s === 'string' && s.trim() && s.length <= SHA_MAX; })) {
    errors.push('each commitSha must be non-empty text, ' + SHA_MAX + ' characters or fewer.');
  } else {
    out.commitShas = body.commitShas.map(function (s) { return s.trim(); });
  }

  if (opts && opts.requireConfidence) {
    if (typeof body.confidence !== 'string' || moonMatch.CONFIDENCE_LEVELS.indexOf(body.confidence) < 0) {
      errors.push('confidence must be one of: ' + moonMatch.CONFIDENCE_LEVELS.join(', '));
    } else {
      out.confidence = body.confidence;
    }
  }

  return { out: out, errors: errors };
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

/* Pure — validates a createEpic/updateEpic payload against the feature
   records it may link to. An epic is itself a record in the same flat
   pds:feature:index array (isEpic: true), so a module board's three bucket
   columns can place it alongside ordinary cards; `bullets` is the curated,
   human-authored grouping — each bullet names one distinct required
   capability and cites the original per-session cards it was synthesized
   from (`featureIds`), which keeps the evidence trail intact instead of
   deleting those cards. `existingFeatures` should exclude the epic being
   edited (if any), so a bullet can't "link" the epic to itself. */
function validateEpicFields(body, existingFeatures) {
  const errors = [];
  const out = {};
  const byId = new Map(existingFeatures.map(function (f) { return [f.id, f]; }));

  if (typeof body.module !== 'string' || !modules.isValidModule(body.module)) {
    errors.push('module must be one of the known modules.');
  } else {
    out.module = body.module;
  }

  if (body.bucket !== undefined) {
    if (typeof body.bucket !== 'string' || !buckets.isValidBucket(body.bucket)) {
      errors.push('bucket must be one of: ' + buckets.BUCKETS.join(', '));
    } else {
      out.bucket = body.bucket;
    }
  } else {
    out.bucket = 'bau';
  }

  if (typeof body.title !== 'string' || !body.title.trim()) {
    errors.push('title is required.');
  } else if (body.title.length > EPIC_TITLE_MAX) {
    errors.push('title is longer than ' + EPIC_TITLE_MAX + ' characters.');
  } else {
    out.title = body.title.trim();
  }

  if (!Array.isArray(body.bullets) || !body.bullets.length) {
    errors.push('bullets must be a non-empty array.');
  } else if (body.bullets.length > EPIC_MAX_BULLETS) {
    errors.push('bullets cannot have more than ' + EPIC_MAX_BULLETS + ' entries.');
  } else {
    const bullets = [];
    const seenFeatureIds = new Set();
    let bulletsOk = true;
    body.bullets.forEach(function (b, i) {
      const n = i + 1;
      if (!bulletsOk) return;
      if (!b || typeof b.text !== 'string' || !b.text.trim()) {
        errors.push('bullet ' + n + ' needs text.'); bulletsOk = false; return;
      }
      if (b.text.length > EPIC_BULLET_TEXT_MAX) {
        errors.push('bullet ' + n + ' text is longer than ' + EPIC_BULLET_TEXT_MAX + ' characters.'); bulletsOk = false; return;
      }
      if (!Array.isArray(b.featureIds) || !b.featureIds.length) {
        errors.push('bullet ' + n + ' needs at least one linked card.'); bulletsOk = false; return;
      }
      if (b.featureIds.length > EPIC_MAX_FEATURE_IDS_PER_BULLET) {
        errors.push('bullet ' + n + ' cannot link more than ' + EPIC_MAX_FEATURE_IDS_PER_BULLET + ' cards.'); bulletsOk = false; return;
      }
      const ids = [];
      for (let j = 0; j < b.featureIds.length; j++) {
        const fid = b.featureIds[j];
        const f = typeof fid === 'string' ? byId.get(fid) : undefined;
        if (!f) { errors.push('bullet ' + n + ' references an unknown card id.'); bulletsOk = false; return; }
        if (f.isEpic) { errors.push('bullet ' + n + ' cannot link to another epic.'); bulletsOk = false; return; }
        if (seenFeatureIds.has(fid)) { errors.push('bullet ' + n + ' links a card already used elsewhere in this epic.'); bulletsOk = false; return; }
        seenFeatureIds.add(fid);
        ids.push(fid);
      }
      if (bulletsOk) bullets.push({ text: b.text.trim(), featureIds: ids });
    });
    if (bulletsOk) out.bullets = bullets;
  }

  return { out: out, errors: errors };
}

/* Pure — every featureId cited across an epic's bullets. */
function epicFeatureIds(epic) {
  return (epic.bullets || []).reduce(function (acc, b) { return acc.concat(b.featureIds); }, []);
}

/* Pure — returns a new items array with `epicId` reconciled for one epic's
   membership change: cards newly cited get epicId set, cards that were
   cited before but no longer are get it cleared (only if it still points at
   this epic — never steal a card another epic claimed independently). */
function withEpicAssignments(items, epicId, previousFeatureIds, nextFeatureIds) {
  const prevSet = new Set(previousFeatureIds || []);
  const nextSet = new Set(nextFeatureIds || []);
  return items.map(function (f) {
    if (nextSet.has(f.id)) return Object.assign({}, f, { epicId: epicId });
    if (prevSet.has(f.id) && f.epicId === epicId) return Object.assign({}, f, { epicId: null });
    return f;
  });
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
  /* Every other action targets an existing record by id; createEpic is the
     one exception, since the epic's id doesn't exist until this call makes
     it — generated server-side, never client-supplied. */
  if (body.action !== 'createEpic' && typeof body.id !== 'string') {
    return res.status(400).json({ error: 'id is required.' });
  }

  if (body.action === 'delete') {
    const items = await store.readFeatureIndex();
    const target = items.find(function (f) { return f.id === body.id; });
    /* Deleting an epic ungroups its member cards instead of leaving their
       epicId dangling — the cards themselves are never touched by this,
       only reassigned back into the plain per-bucket board. */
    const next = (target && target.isEpic)
      ? withEpicAssignments(items, target.id, epicFeatureIds(target), [])
      : items;
    await store.writeFeatureIndex(next.filter(function (f) { return f.id !== body.id; }));
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

  if (body.action === 'suggestComplete') {
    const items = await store.readFeatureIndex();
    const feature = items.find(function (f) { return f.id === body.id; });
    if (!feature) return res.status(404).json({ error: 'No feature with that id.' });
    if (feature.complete) return res.status(200).json({ ok: true, item: feature, skipped: 'already complete' });

    const patch = validateEvidence(body, { requireConfidence: true });
    if (patch.errors.length) return res.status(400).json({ error: patch.errors.join(' ') });

    feature.autoCompleteSuggestion = {
      confidence: patch.out.confidence,
      reason: patch.out.reason,
      commitShas: patch.out.commitShas,
      suggestedAt: new Date().toISOString()
    };
    feature.updatedAt = new Date().toISOString();
    await store.writeFeatureIndex(items);
    return res.status(200).json({ ok: true, item: feature });
  }

  if (body.action === 'autoComplete') {
    const items = await store.readFeatureIndex();
    const feature = items.find(function (f) { return f.id === body.id; });
    if (!feature) return res.status(404).json({ error: 'No feature with that id.' });
    if (feature.complete) return res.status(200).json({ ok: true, item: feature, skipped: 'already complete' });

    const patch = validateEvidence(body, { requireConfidence: false });
    if (patch.errors.length) return res.status(400).json({ error: patch.errors.join(' ') });

    Object.assign(feature, applyPatch(feature, { complete: true }), {
      autoCompletedFrom: { reason: patch.out.reason, commitShas: patch.out.commitShas, completedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString()
    });
    await store.writeFeatureIndex(items);
    return res.status(200).json({ ok: true, item: feature });
  }

  if (body.action === 'createEpic') {
    const items = await store.readFeatureIndex();
    const v = validateEpicFields(body, items);
    if (v.errors.length) return res.status(400).json({ error: v.errors.join(' ') });

    const now = new Date().toISOString();
    const epic = {
      id: crypto.randomUUID(),
      isEpic: true,
      module: v.out.module,
      bucket: v.out.bucket,
      title: v.out.title,
      bullets: v.out.bullets.map(function (b) { return Object.assign({ id: crypto.randomUUID() }, b); }),
      createdAt: now,
      updatedAt: now
    };
    const withAssignments = withEpicAssignments(items, epic.id, [], epicFeatureIds(epic));
    await store.writeFeatureIndex(withAssignments.concat([epic]));
    return res.status(200).json({ ok: true, item: epic });
  }

  if (body.action === 'updateEpic') {
    const items = await store.readFeatureIndex();
    const epic = items.find(function (f) { return f.id === body.id && f.isEpic; });
    if (!epic) return res.status(404).json({ error: 'No epic with that id.' });

    const v = validateEpicFields(body, items.filter(function (f) { return f.id !== epic.id; }));
    if (v.errors.length) return res.status(400).json({ error: v.errors.join(' ') });

    const previousFeatureIds = epicFeatureIds(epic);
    const nextBullets = v.out.bullets.map(function (b, i) {
      const existing = epic.bullets[i];
      return Object.assign({ id: (existing && existing.id) || crypto.randomUUID() }, b);
    });
    const updatedEpic = Object.assign({}, epic, {
      module: v.out.module,
      bucket: v.out.bucket,
      title: v.out.title,
      bullets: nextBullets,
      updatedAt: new Date().toISOString()
    });

    const reconciled = withEpicAssignments(items, epic.id, previousFeatureIds, epicFeatureIds(updatedEpic));
    const next = reconciled.map(function (f) { return f.id === epic.id ? updatedEpic : f; });
    await store.writeFeatureIndex(next);
    return res.status(200).json({ ok: true, item: updatedEpic });
  }

  if (body.action === 'dismissSuggestion') {
    const items = await store.readFeatureIndex();
    const feature = items.find(function (f) { return f.id === body.id; });
    if (!feature) return res.status(404).json({ error: 'No feature with that id.' });

    feature.autoCompleteSuggestion = null;
    feature.updatedAt = new Date().toISOString();
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
module.exports.validateEvidence = validateEvidence;
module.exports.validateEpicFields = validateEpicFields;
module.exports.epicFeatureIds = epicFeatureIds;
module.exports.withEpicAssignments = withEpicAssignments;
