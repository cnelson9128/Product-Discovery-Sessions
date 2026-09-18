'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');
const raisedItems = require('../lib/raised-items');
const featureSync = require('../lib/feature-sync');
const moduleClassification = require('../lib/module-classification');

/*
 * One-time (but safe to re-run) backfill for content-based module
 * classification, hit once via curl after deploying that feature, per the
 * README — same convention as api/admin-migrate-features.js.
 *
 * Two passes, each independently idempotent:
 *  1. Any ready session analyzed before this feature shipped has no
 *     `raisedItems` yet. For each one, extract it (without touching the
 *     session's existing 11-question `analysis` at all) and sync feature
 *     cards from it. A session that already has `raisedItems` is skipped —
 *     re-running this endpoint does not re-extract or duplicate anything.
 *  2. Any existing feature card with no `sourceItemKey` (created by the old
 *     per-module trend-build pipeline, before cards were linked to a
 *     specific extracted item) and no `isManualModule` override gets
 *     reclassified in one batched call against just its `item`/`rationale`
 *     text. A card that already has a `sourceItemKey`, or that a human has
 *     manually moved, is left alone — re-running this endpoint reclassifies
 *     nothing a second time.
 *
 * Processes sessions sequentially (each is its own LLM call) rather than in
 * parallel, to stay well under Vercel's function timeout with a realistic
 * backlog. If there are more sessions to backfill than fit in one run before
 * the timeout, call this endpoint again — already-backfilled sessions are
 * skipped, so it naturally picks up where it left off.
 */
/* Pure predicates — what makes a session/feature eligible for this endpoint's
   two passes. Exported so test/admin-reclassify.test.js can assert
   idempotency (an already-backfilled session, or an already-classified/
   overridden feature, is never re-touched) without mocking Redis or
   Anthropic. */
function needsRaisedItemsBackfill(session) {
  return !Array.isArray(session.raisedItems);
}
function needsReclassification(feature) {
  /* classificationReason is the tell that a card has been classified before
     — either linked to an extracted item (sourceItemKey) or already run
     through this endpoint's batch reclassifier once. Without checking it, a
     legacy card would never gain a sourceItemKey and would get reclassified
     (another LLM call) on every single run, breaking the idempotency this
     endpoint promises. */
  return !feature.sourceItemKey && !feature.isManualModule && !feature.classificationReason;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  if (!store.configured()) {
    return res.status(503).json({ error: 'No Redis store is linked.', diagnostics: store.diagnostics() });
  }

  const sessionResults = { backfilled: 0, skipped: 0, failed: [] };
  const index = await store.readSessionIndex();
  const readyEntries = index.filter(function (e) { return e.status === 'ready'; });

  for (const entry of readyEntries) {
    const record = await store.readSession(entry.id);
    if (!record) continue;
    if (!needsRaisedItemsBackfill(record)) { sessionResults.skipped++; continue; }

    try {
      const moduleLabel = modules.labelFor(record.module);
      const extracted = await raisedItems.extractRaisedItems(record, moduleLabel);
      const now = new Date().toISOString();
      const updated = Object.assign({}, record, {
        raisedItems: extracted.raisedItems,
        raisedItemsModel: extracted.model,
        raisedItemsGeneratedAt: now,
        raisedItemsError: null
      });
      await store.writeSession(record.id, updated);
      await featureSync.syncFeaturesForSession(updated);
      sessionResults.backfilled++;
    } catch (err) {
      sessionResults.failed.push({ sessionId: record.id, reason: (err && err.message) || 'unknown error' });
    }
  }

  const featureResults = { reclassified: 0, skipped: 0, failed: null };
  const features = await store.readFeatureIndex();
  const legacy = features.filter(needsReclassification);
  featureResults.skipped = features.length - legacy.length;

  if (legacy.length) {
    try {
      const classified = await moduleClassification.classifyExistingItems(
        legacy.map(function (f) { return { key: f.id, item: f.item, rationale: f.rationale }; })
      );
      const byKey = new Map(classified.map(function (c) { return [c.key, c]; }));
      const now = new Date().toISOString();
      features.forEach(function (f) {
        const c = byKey.get(f.id);
        if (!c) return;
        f.module = c.primary_module;
        f.secondaryModules = c.secondary_modules || [];
        f.confidence = c.confidence;
        f.classificationReason = c.classification_reason;
        f.updatedAt = now;
        featureResults.reclassified++;
      });
      await store.writeFeatureIndex(features);
    } catch (err) {
      featureResults.failed = (err && err.message) || 'unknown error';
    }
  }

  return res.status(200).json({ ok: true, sessions: sessionResults, features: featureResults });
};

module.exports.needsRaisedItemsBackfill = needsRaisedItemsBackfill;
module.exports.needsReclassification = needsReclassification;
