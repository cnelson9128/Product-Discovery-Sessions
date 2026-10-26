'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const moduleClassification = require('../lib/module-classification');

const OLD_COMBINED_MODULE = 'business-development-marketing';
const CLASSIFY_BATCH_SIZE = 20;

/*
 * One-time (but safe to re-run) migration for splitting the old combined
 * "Business Development & Marketing" module into two: `business-development-
 * marketing` (kept, narrowed to Business Development only — see
 * lib/modules.js's header) and the new `marketing` module. Reclassifies
 * every existing raised item / feature card currently filed under the old
 * combined id against the new, narrower rule set
 * (lib/module-classification.js) — items that are genuinely Business
 * Development are left exactly as they are; items that are really candidate
 * marketing/campaigns/acquisition move to `marketing`. A human-overridden
 * card (isManualModule) is never touched, same as every other classification
 * pass in this app.
 *
 * Two passes:
 *  1. Every session's `raisedItems` entries currently classified under the
 *     old combined module are re-classified and updated in place on the
 *     session record. This has to happen first and separately from the
 *     feature pass below: lib/feature-sync.js reads a card's module back
 *     from here on every future re-analysis, so fixing only the card
 *     without this would have it revert on the next "Regenerate."
 *  2. Every non-overridden feature card currently in the old combined
 *     module is re-synced: from its linked session's (now-updated)
 *     raisedItems entry if it has one, or reclassified directly from its
 *     own item/rationale text if it's a legacy card with no session link
 *     (same fallback api/features.js's resetClassification uses).
 *
 * Safe to re-run, but not a strict no-op: an item that's still genuinely
 * Business Development keeps the same id, so a later run will classify it
 * again rather than skip it outright (a small, bounded, harmless cost) —
 * this migration doesn't add a permanent "already reviewed" marker to the
 * data model for what's a one-time administrative task. Nothing outside the
 * old combined module's existing cards/items is read or written.
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
    return res.status(503).json({ error: 'No Redis store is linked.', diagnostics: store.diagnostics() });
  }

  const sessionResults = { sessionsUpdated: 0, itemsReviewed: 0, itemsMoved: 0, failed: [] };
  const index = await store.readSessionIndex();

  for (const entry of index) {
    const record = await store.readSession(entry.id);
    if (!record || !Array.isArray(record.raisedItems)) continue;

    const candidates = [];
    record.raisedItems.forEach(function (item, i) {
      if (needsSessionItemReview(item)) candidates.push({ key: String(i), item: item.item, rationale: item.rationale });
    });
    if (!candidates.length) continue;

    try {
      const classified = await classifyInBatches(candidates);
      let changed = false;
      classified.forEach(function (c) {
        const item = record.raisedItems[Number(c.key)];
        if (!item) return;
        sessionResults.itemsReviewed++;
        if (c.primary_module === OLD_COMBINED_MODULE) return; // genuinely Business Development — leave as is
        item.primary_module = c.primary_module;
        item.secondary_modules = c.secondary_modules || [];
        item.confidence = c.confidence;
        item.classification_reason = c.classification_reason;
        changed = true;
        sessionResults.itemsMoved++;
      });
      if (changed) {
        await store.writeSession(record.id, record);
        sessionResults.sessionsUpdated++;
      }
    } catch (err) {
      sessionResults.failed.push({ sessionId: record.id, reason: (err && err.message) || 'unknown error' });
    }
  }

  const featureResults = { reviewed: 0, moved: 0, skippedManual: 0, failed: [] };
  const features = await store.readFeatureIndex();
  const toReview = features.filter(needsFeatureReview);

  for (const f of toReview) {
    if (f.isManualModule) { featureResults.skippedManual++; continue; }

    let restored = null;
    if (f.sourceSessionId && f.sourceItemKey) {
      const originSession = await store.readSession(f.sourceSessionId);
      const itemIndex = Number(f.sourceItemKey.split('#').pop());
      const raised = originSession && Array.isArray(originSession.raisedItems) ? originSession.raisedItems[itemIndex] : null;
      if (raised && raised.primary_module !== OLD_COMBINED_MODULE) {
        restored = {
          module: raised.primary_module,
          secondaryModules: raised.secondary_modules || [],
          confidence: raised.confidence,
          classificationReason: raised.classification_reason
        };
      }
    }

    if (!restored) {
      try {
        const classified = await moduleClassification.classifyExistingItems([{ key: f.id, item: f.item, rationale: f.rationale }]);
        const c = classified[0];
        if (c && c.primary_module !== OLD_COMBINED_MODULE) {
          restored = {
            module: c.primary_module,
            secondaryModules: c.secondary_modules || [],
            confidence: c.confidence,
            classificationReason: c.classification_reason
          };
        }
      } catch (err) {
        featureResults.failed.push({ featureId: f.id, reason: (err && err.message) || 'unknown error' });
        continue;
      }
    }

    featureResults.reviewed++;
    if (restored && restored.module !== f.module) {
      const history = Array.isArray(f.moduleHistory) ? f.moduleHistory.slice() : [];
      history.push({ at: new Date().toISOString(), from: f.module, to: restored.module });
      Object.assign(f, restored, { moduleHistory: history, updatedAt: new Date().toISOString() });
      featureResults.moved++;
    }
  }

  if (featureResults.moved > 0) await store.writeFeatureIndex(features);

  return res.status(200).json({ ok: true, sessions: sessionResults, features: featureResults });
};

/* Pure predicates — exported for test/admin-split-marketing-module.test.js. */
function needsSessionItemReview(item) {
  return !!item && item.primary_module === OLD_COMBINED_MODULE;
}
/* Module membership only — whether a card is actually reclassified or
   skipped as a manual override is decided in the handler's loop below, so
   that skip gets counted in featureResults.skippedManual instead of being
   silently filtered out before the loop ever sees it. */
function needsFeatureReview(feature) {
  return feature.module === OLD_COMBINED_MODULE;
}

async function classifyInBatches(candidates) {
  const out = [];
  for (let i = 0; i < candidates.length; i += CLASSIFY_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + CLASSIFY_BATCH_SIZE);
    const classified = await moduleClassification.classifyExistingItems(chunk);
    out.push.apply(out, classified);
  }
  return out;
}

module.exports.OLD_COMBINED_MODULE = OLD_COMBINED_MODULE;
module.exports.needsSessionItemReview = needsSessionItemReview;
module.exports.needsFeatureReview = needsFeatureReview;
