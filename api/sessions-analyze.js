'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const analysis = require('../lib/analysis');
const modules = require('../lib/modules');
const batches = require('../lib/batches');
const raisedItems = require('../lib/raised-items');
const migrationRisk = require('../lib/migration-risk');
const featureSync = require('../lib/feature-sync');

/*
 * Generates (or regenerates) the analysis for one session, on either track.
 * Split out from api/sessions.js because this is the one slow, expensive
 * operation in this feature — LLM calls, not a Redis round trip — and needs
 * its own maxDuration in vercel.json.
 *
 * Runs the 11-question analysis and the raised-items extraction (which
 * feeds the roadmap board's feature cards, classified by content — see
 * lib/raised-items.js) in parallel for every session, on either track: both
 * only need the transcript, so this adds no wall-clock cost over a single
 * call. A migration-readiness session additionally runs
 * lib/migration-risk.js's risk-profile extraction in the same parallel
 * batch. Each of the two extra calls fails in isolation — captured on
 * raisedItemsError/migrationRiskError — and never blocks the (already-
 * working) 11-question result from saving.
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

  const isMigration = record.track === 'migration-readiness';

  try {
    const topicLabel = isMigration
      ? batches.labelFor(record.batch) + ': ' + batches.descriptionFor(record.batch)
      : modules.labelFor(record.module);

    const calls = [
      analysis.generateAnalysis(record, topicLabel),
      raisedItems.extractRaisedItems(record, topicLabel).catch(function (err) {
        return { error: (err && err.message) || 'unknown error' };
      })
    ];
    if (isMigration) {
      calls.push(
        migrationRisk.generateMigrationRisk(record, batches.labelFor(record.batch), batches.descriptionFor(record.batch))
          .catch(function (err) {
            return { error: (err && err.message) || 'unknown error' };
          })
      );
    }

    const [analysisResult, raisedItemsOutcome, migrationRiskOutcome] = await Promise.all(calls);

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

    if (isMigration) {
      if (migrationRiskOutcome.error) {
        updated.migrationRiskError = migrationRiskOutcome.error;
      } else {
        updated.migrationRisk = migrationRiskOutcome.migrationRisk;
        updated.migrationRiskModel = migrationRiskOutcome.model;
        updated.migrationRiskGeneratedAt = now;
        updated.migrationRiskError = null;
      }
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

    await syncIndexStatus(body.id, 'ready', updated.updatedAt, isMigration && updated.migrationRisk
      ? { migrationReadinessVerdict: updated.migrationRisk.overall_readiness.verdict }
      : {});
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
    await syncIndexStatus(body.id, 'error', now, {});

    const status = err && err.code === 'NO_API_KEY' ? 503 : 502;
    return res.status(status).json({
      error: 'Could not generate the analysis: ' + reason +
        '. The transcript and session details are still saved — try Regenerate.',
      item: updated
    });
  }
};

async function syncIndexStatus(id, status, updatedAt, extra) {
  const index = await store.readSessionIndex();
  const next = index.map(function (e) {
    return e.id === id ? Object.assign({}, e, { status: status, updatedAt: updatedAt }, extra || {}) : e;
  });
  await store.writeSessionIndex(next);
}
