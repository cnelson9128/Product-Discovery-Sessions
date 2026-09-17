'use strict';

const crypto = require('crypto');
const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');
const moduleTrends = require('../lib/module-trends');
const trendCards = require('../lib/trend-cards');

/*
 * (Re)builds the trend synthesis for one module from every currently-ready
 * session tagged to it. Split out from api/module-trends.js because this is
 * the one slow, expensive operation here — an LLM call, not a Redis round
 * trip — and needs its own maxDuration in vercel.json, same reasoning as
 * api/sessions-analyze.js relative to api/sessions.js.
 *
 * PURELY ADDITIVE: this is a roadmap board now, not disposable AI output.
 * A build only ever APPENDS newly-surfaced features to the shared
 * pds:feature:index — it never mutates, reorders, or removes a feature
 * already there, regardless of which module or which earlier build it came
 * from. Manual edits (bucket, module, owner, complete, requirementsDone) are
 * permanent user data and this endpoint has no business touching them.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  if (!store.configured()) {
    return res.status(503).json({
      error: 'No Redis store is linked, so the trend cannot be saved. Add an Upstash Redis ' +
        'integration from the Vercel Marketplace, then redeploy.',
      diagnostics: store.diagnostics()
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const moduleId = body.module;
  if (typeof moduleId !== 'string' || !modules.isValidModule(moduleId)) {
    return res.status(400).json({ error: 'module is required and must be one of the known modules.' });
  }

  const index = await store.readSessionIndex();
  const readyEntries = index.filter(function (e) { return e.module === moduleId && e.status === 'ready'; });
  if (!readyEntries.length) {
    return res.status(400).json({ error: 'No analyzed sessions for this module yet. Log and analyze at least one session first.' });
  }

  const fullRecords = await Promise.all(readyEntries.map(function (e) { return store.readSession(e.id); }));
  const sessionInputs = fullRecords
    .filter(Boolean)
    .map(function (r) {
      return { sessionId: r.id, clientName: r.customerName, sessionDate: r.sessionDate, analysis: r.analysis };
    });

  const previous = await store.readModuleTrend(moduleId);
  const moduleLabel = modules.labelFor(moduleId);

  try {
    const generated = await moduleTrends.generateTrend(moduleLabel, sessionInputs);
    const now = new Date().toISOString();

    const candidates = trendCards.toCandidateItems(generated.result);
    const features = await store.readFeatureIndex();
    const existingInModule = features.filter(function (f) { return f.module === moduleId; });

    /* Narrow, literal-string safety net — not real dedup. Without this, an
       unchanged rebuild would append the same wording again every time,
       since "purely additive" otherwise has no way to know a candidate is
       the same feature it already surfaced last time. Only skips an EXACT
       (case-insensitive) match on `item` within the same module; anything
       even slightly reworded is treated as new and appended, matching this
       function's "when in doubt, add rather than silently drop" bias. */
    const existingItemTexts = existingInModule.map(function (f) { return f.item.trim().toLowerCase(); });
    const added = [];
    candidates.forEach(function (c) {
      if (existingItemTexts.indexOf(c.item.trim().toLowerCase()) >= 0) return;
      const record = {
        id: crypto.randomUUID(),
        module: moduleId,
        item: c.item,
        rationale: c.rationale,
        supporting_session_ids: c.supporting_session_ids,
        bucket: c.bucket,
        owner: '',
        complete: false,
        requirementsDone: false,
        createdAt: now,
        updatedAt: now
      };
      features.push(record);
      added.push(record);
    });
    await store.writeFeatureIndex(features);

    const record = {
      module: moduleId,
      status: 'ready',
      builtAt: now,
      builtFromSessionIds: sessionInputs.map(function (s) { return s.sessionId; }),
      sessionCountAtBuild: sessionInputs.length,
      model: generated.model,
      usage: generated.usage,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
      result: {
        overview_summary: generated.result.overview_summary,
        value_moments: generated.result.value_moments,
        adoption_blockers: generated.result.adoption_blockers,
        gtm_messaging: generated.result.gtm_messaging
      }
    };
    await store.writeModuleTrend(moduleId, record);
    return res.status(200).json({ ok: true, item: record, featuresAdded: added.length });
  } catch (err) {
    const reason = (err && err.message) || 'unknown error';
    console.error('module trend generation failed:', moduleId, err && err.code, reason);
    const now = new Date().toISOString();
    /* Keep the previous result/builtFromSessionIds on a failed rebuild — a
       failed refresh must never wipe a previously-successful trend. Note
       this branch never touches the feature index at all — a failed
       generation means there's nothing new to append, not a reason to
       remove anything already there. */
    const record = Object.assign({}, previous, {
      module: moduleId,
      status: 'error',
      lastError: reason,
      lastErrorCode: (err && err.code) || null,
      lastErrorAt: now,
      result: previous ? previous.result : null,
      builtFromSessionIds: previous ? previous.builtFromSessionIds : [],
      builtAt: previous ? previous.builtAt : null,
      sessionCountAtBuild: previous ? previous.sessionCountAtBuild : 0
    });
    await store.writeModuleTrend(moduleId, record);

    const status = err && err.code === 'NO_API_KEY' ? 503 : 502;
    return res.status(status).json({
      error: 'Could not build the trend: ' + reason + '.' +
        (previous ? ' The previous trend is still available.' : ''),
      item: record
    });
  }
};
