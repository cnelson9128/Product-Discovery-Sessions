'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const analysis = require('../lib/analysis');
const modules = require('../lib/modules');
const raisedItems = require('../lib/raised-items');
const featureSync = require('../lib/feature-sync');

/*
 * Generates (or regenerates) the analysis for one discovery session. Split
 * out from api/sessions.js because this is the one slow, expensive operation
 * in this feature — an LLM call, not a Redis round trip — and needs its own
 * maxDuration in vercel.json.
 *
 * Runs the 11-question analysis and the raised-items extraction (which
 * feeds the roadmap board's feature cards, classified by content — see
 * lib/raised-items.js) in parallel: both only need the transcript, so this
 * adds no wall-clock cost over the single call that used to happen here. A
 * raised-items failure is captured on `raisedItemsError` and never fails
 * this request or blocks the (already-working) 11-question result from
 * saving — the Sessions tab must keep working exactly as it does today even
 * if the newer, separate extraction has a bad day.
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
      error: 'No Redis store is linked, so the result cannot be saved. Add an Upstash Redis ' +
        'integration from the Vercel Marketplace, then redeploy.',
      diagnostics: store.diagnostics()
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.id !== 'string') return res.status(400).json({ error: 'id is required.' });

  const record = await store.readSession(body.id);
  if (!record) return res.status(404).json({ error: 'No session with that id.' });

  try {
    const moduleLabel = modules.labelFor(record.module);
    const [analysisResult, raisedItemsOutcome] = await Promise.all([
      analysis.generateAnalysis(record, moduleLabel),
      raisedItems.extractRaisedItems(record, moduleLabel).catch(function (err) {
        return { error: (err && err.message) || 'unknown error' };
      })
    ]);

    const now = new Date().toISOString();
    const updated = Object.assign({}, record, {
      analysis: analysisResult.analysis,
      analysisModel: analysisResult.model,
      analysisGeneratedAt: now,
      status: 'ready',
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedAt: now
    });

    if (raisedItemsOutcome.error) {
      updated.raisedItemsError = raisedItemsOutcome.error;
      /* Keep whatever raisedItems this session already had (e.g. from a
         previous successful Regenerate) rather than wiping it on a
         transient failure. */
    } else {
      updated.raisedItems = raisedItemsOutcome.raisedItems;
      updated.raisedItemsModel = raisedItemsOutcome.model;
      updated.raisedItemsGeneratedAt = now;
      updated.raisedItemsError = null;
    }

    await store.writeSession(body.id, updated);

    if (!raisedItemsOutcome.error) {
      try {
        await featureSync.syncFeaturesForSession(updated);
      } catch (syncErr) {
        updated.raisedItemsError = 'Extracted, but could not sync feature cards: ' +
          ((syncErr && syncErr.message) || 'unknown error');
        await store.writeSession(body.id, updated);
      }
    }

    await syncIndexStatus(body.id, 'ready', updated.updatedAt);
    return res.status(200).json({ ok: true, item: updated });
  } catch (err) {
    const reason = (err && err.message) || 'unknown error';
    console.error('analysis generation failed:', err && err.code, reason);
    const now = new Date().toISOString();
    /* Persisted, not just returned in this response — so the reason survives
       a page refresh and shows up the next time this session is opened. */
    const updated = Object.assign({}, record, {
      status: 'error',
      lastError: reason,
      lastErrorCode: (err && err.code) || null,
      lastErrorAt: now,
      updatedAt: now
    });
    await store.writeSession(body.id, updated);
    await syncIndexStatus(body.id, 'error', now);

    const status = err && err.code === 'NO_API_KEY' ? 503 : 502;
    return res.status(status).json({
      error: 'Could not generate the analysis: ' + reason +
        '. The transcript and session details are still saved — try Regenerate.',
      item: updated
    });
  }
};

async function syncIndexStatus(id, status, updatedAt) {
  const index = await store.readSessionIndex();
  const next = index.map(function (e) {
    return e.id === id ? Object.assign({}, e, { status: status, updatedAt: updatedAt }) : e;
  });
  await store.writeSessionIndex(next);
}
