'use strict';

/*
 * Converts a module trend's raw model output into candidate roadmap-feature
 * items, and validates the bucket a feature lives in on the board.
 *
 * lib/module-trends.js asks the model for now/later/future — that's just its
 * internal generation vocabulary, a sensible one for an LLM to reason in.
 * What actually gets persisted is a first-class "feature" entity (see
 * lib/store.js's readFeatureIndex/writeFeatureIndex and api/features.js),
 * identified by this program's real terminology: `bucket` is one of
 * launch/phase2/bau (displayed as Launch / Phase 2 / Future Considerations).
 *
 * This module only knows how to shape a fresh candidate from a build's raw
 * output — it has no opinion on `id`, `owner`, `complete`, or
 * `requirementsDone`, since those are properties of the persisted feature
 * record, assigned once at creation (api/module-trends-build.js) and edited
 * thereafter (api/features.js), not of any one build's output.
 */

const BUCKETS = ['launch', 'phase2', 'bau'];

function isValidBucket(bucket) {
  return BUCKETS.indexOf(bucket) >= 0;
}

/* result is the raw model output — {feature_prioritization: {now, later, future}, ...}.
   Returns candidate items only — no id, no complete/requirementsDone/owner —
   ready for api/module-trends-build.js to turn into full feature records. */
function toCandidateItems(result) {
  const fp = (result && result.feature_prioritization) || {};
  const fromArray = function (arr, bucket) {
    return (arr || []).map(function (it) {
      return {
        item: it.item,
        rationale: it.rationale,
        supporting_session_ids: it.supporting_session_ids || [],
        bucket: bucket
      };
    });
  };
  return [].concat(fromArray(fp.now, 'launch'), fromArray(fp.later, 'phase2'), fromArray(fp.future, 'bau'));
}

module.exports = { BUCKETS, isValidBucket, toCandidateItems };
