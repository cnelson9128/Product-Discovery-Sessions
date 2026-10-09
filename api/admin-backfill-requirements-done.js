'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');

/*
 * One-time (but safe to re-run) correction: a feature can't be complete
 * without its requirements already having been done, so any existing
 * feature marked `complete` but not `requirementsDone` has its
 * `requirementsDone` flag brought in line. api/features.js's applyPatch
 * enforces this going forward for every new completion — this endpoint only
 * exists to correct records that predate that rule.
 *
 * Idempotent — a feature with nothing to correct is left untouched, so
 * running this more than once, or on a board with nothing to backfill, is a
 * true no-op.
 */
function needsBackfill(feature) {
  return feature.complete === true && feature.requirementsDone !== true;
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

  const features = await store.readFeatureIndex();
  const now = new Date().toISOString();
  let updated = 0;

  features.forEach(function (f) {
    if (!needsBackfill(f)) return;
    f.requirementsDone = true;
    f.updatedAt = now;
    updated++;
  });

  if (updated > 0) await store.writeFeatureIndex(features);

  return res.status(200).json({ ok: true, updated: updated, total: features.length });
};

module.exports.needsBackfill = needsBackfill;
