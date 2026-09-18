'use strict';

/*
 * The three roadmap-board priority buckets a feature card lives in — Launch /
 * Phase 2 / Future Considerations — and validation for it. Used by
 * api/features.js (moving a card) and public/index.html (must match this
 * list exactly).
 *
 * Was lib/trend-cards.js's `toCandidateItems` also used to live here — that
 * turned a module trend's `feature_prioritization` output into candidate
 * feature records, back when "Build trend" was how cards were created.
 * Feature cards are now sourced from lib/feature-sync.js (classified
 * per-item, per-session, independent of any module trend build), so bucket
 * placement is a purely human/product-team judgment call made on the board,
 * not something an AI build assigns — `toCandidateItems` and
 * `feature_prioritization` had no remaining reason to exist and were
 * removed rather than left as dead code.
 */

const BUCKETS = ['launch', 'phase2', 'bau'];

function isValidBucket(bucket) {
  return BUCKETS.indexOf(bucket) >= 0;
}

module.exports = { BUCKETS, isValidBucket };
