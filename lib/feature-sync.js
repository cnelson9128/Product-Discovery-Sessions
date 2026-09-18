'use strict';

/*
 * Turns one session's extracted `raisedItems` (lib/raised-items.js) into
 * feature-index records — the mechanism that replaces the old per-module
 * "Build trend" candidate generation (see api/module-trends-build.js, which
 * no longer touches the feature index at all).
 *
 * Each raised item is linked to a feature record via a stable
 * `sourceItemKey` (`${sessionId}#${itemIndex}`), so re-running extraction —
 * a "Regenerate" on the session — updates that same card in place instead of
 * duplicating it. A card a human has manually reassigned (`isManualModule`)
 * keeps its module/secondaryModules/confidence/classificationReason exactly
 * as a human left them on every future sync; only its `item`/`rationale`/
 * `evidenceQuote` text refreshes, since that's the parser's read of what was
 * actually said, not a classification judgment call.
 *
 * Never removes a card whose source item disappears from a shorter
 * re-extraction — someone may already be working it.
 */

const crypto = require('crypto');
const store = require('./store');

function sourceItemKey(sessionId, itemIndex) {
  return sessionId + '#' + itemIndex;
}

/* Pure — no store access — so this is the part unit tests exercise directly.
   Returns {features, created, updated}; `features` is a new array, existing
   records that don't change are kept by reference. */
function mergeSessionFeatures(session, existingFeatures) {
  const raised = Array.isArray(session.raisedItems) ? session.raisedItems : [];
  const now = new Date().toISOString();
  const features = existingFeatures.slice();
  const indexByKey = new Map();
  features.forEach(function (f, idx) {
    if (f.sourceItemKey) indexByKey.set(f.sourceItemKey, idx);
  });

  let created = 0;
  let updated = 0;

  raised.forEach(function (raisedItem, i) {
    const key = sourceItemKey(session.id, i);
    const existingIdx = indexByKey.get(key);

    if (existingIdx !== undefined) {
      const existing = features[existingIdx];
      const next = Object.assign({}, existing, {
        item: raisedItem.item,
        rationale: raisedItem.rationale,
        evidenceQuote: raisedItem.evidence,
        updatedAt: now
      });
      if (!existing.isManualModule) {
        next.module = raisedItem.primary_module;
        next.secondaryModules = raisedItem.secondary_modules || [];
        next.confidence = raisedItem.confidence;
        next.classificationReason = raisedItem.classification_reason;
      }
      features[existingIdx] = next;
      updated++;
      return;
    }

    features.push({
      id: crypto.randomUUID(),
      module: raisedItem.primary_module,
      secondaryModules: raisedItem.secondary_modules || [],
      confidence: raisedItem.confidence,
      classificationReason: raisedItem.classification_reason,
      item: raisedItem.item,
      rationale: raisedItem.rationale,
      evidenceQuote: raisedItem.evidence,
      supporting_session_ids: [session.id],
      sourceSessionId: session.id,
      sourceItemKey: key,
      /* Deliberately not a priority signal — bucket is now purely the human/
         product-team's call, made on the board via the existing bucket
         control. "bau" (Future Considerations) is the least commitment-
         implying default for a card nobody has triaged yet. */
      bucket: 'bau',
      owner: '',
      complete: false,
      requirementsDone: false,
      isManualModule: false,
      moduleHistory: [],
      createdAt: now,
      updatedAt: now
    });
    created++;
  });

  return { features: features, created: created, updated: updated };
}

async function syncFeaturesForSession(session) {
  const existing = await store.readFeatureIndex();
  const merged = mergeSessionFeatures(session, existing);
  if (merged.created || merged.updated) await store.writeFeatureIndex(merged.features);
  return { created: merged.created, updated: merged.updated };
}

module.exports = { mergeSessionFeatures, syncFeaturesForSession, sourceItemKey };
