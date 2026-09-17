'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');

/*
 * One-time migration: moves any old-shape module trend's embedded
 * `result.cards` (from before feature cards were promoted to the first-class
 * pds:feature:index collection) into that collection, then strips
 * `cards`/`counts` from the trend record. Idempotent — a trend with no
 * `result.cards` left is simply skipped, so calling this more than once (or
 * on a fresh install with nothing to migrate) is always a safe no-op.
 *
 * Not part of the app's steady-state surface: hit once via curl after
 * deploying the roadmap-board upgrade, per the README, then it's safe to
 * leave in place or remove in a later cleanup commit.
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
      error: 'No Redis store is linked.',
      diagnostics: store.diagnostics()
    });
  }

  const features = await store.readFeatureIndex();
  const migratedModules = [];
  let migratedCount = 0;

  for (const moduleId of modules.MODULE_IDS) {
    const trend = await store.readModuleTrend(moduleId);
    if (!trend || !trend.result || !Array.isArray(trend.result.cards)) continue;

    trend.result.cards.forEach(function (card) {
      features.push({
        id: card.id,
        module: moduleId,
        item: card.item,
        rationale: card.rationale,
        supporting_session_ids: card.supporting_session_ids || [],
        bucket: card.bucket,
        owner: '',
        complete: !!card.complete,
        requirementsDone: false,
        createdAt: trend.builtAt || new Date().toISOString(),
        updatedAt: trend.builtAt || new Date().toISOString()
      });
      migratedCount++;
    });

    delete trend.result.cards;
    delete trend.counts;
    await store.writeModuleTrend(moduleId, trend);
    migratedModules.push(moduleId);
  }

  if (migratedCount > 0) await store.writeFeatureIndex(features);

  return res.status(200).json({
    ok: true,
    migratedCount: migratedCount,
    migratedModules: migratedModules
  });
};
