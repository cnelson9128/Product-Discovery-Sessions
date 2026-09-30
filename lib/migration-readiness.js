'use strict';

/*
 * Rolls up a batch's readiness from its sessions' denormalized
 * `migrationReadinessVerdict` (set on the session index entry once a
 * migration-readiness session's risk profile has been generated — see
 * api/sessions-analyze.js). Pure — no store access — so the batch overview
 * page can compute it from session-index entries it already has, with no
 * extra fetch. Duplicated verbatim in public/index.html (no bundler, no
 * import — same convention as lib/buckets.js's BUCKETS being duplicated
 * there too), since nothing server-side needs this rollup.
 *
 * Never claims a color off partial data: a batch expects two sessions, and
 * stays "grey" (not yet assessed / partial) until both are analyzed. Once
 * both are in, the rollup is the WORST of the two verdicts — a batch is only
 * as ready as its riskiest customer signal, not an average of the two.
 */

const RANK = { ready: 0, minor_concerns: 1, major_concerns: 2, not_ready: 3 };
const LABELS = { ready: 'Ready', minor_concerns: 'Minor concerns', major_concerns: 'Major concerns', not_ready: 'Not ready' };
const LEVELS = { ready: 'green', minor_concerns: 'amber', major_concerns: 'red', not_ready: 'red' };

/* sessionEntries: this batch's session-index entries (each may or may not
   have status/migrationReadinessVerdict yet). expectedCount defaults to 2
   (the program's standard two-customers-per-batch design), but is a
   parameter rather than a hardcoded 2 so a batch whose roster only has one
   client filled in doesn't get stuck showing "partial" forever. */
function rollupBatchReadiness(sessionEntries, expectedCount) {
  const expected = typeof expectedCount === 'number' && expectedCount > 0 ? expectedCount : 2;
  const assessed = (sessionEntries || []).filter(function (e) {
    return e.status === 'ready' && !!e.migrationReadinessVerdict;
  });

  if (!assessed.length) return { level: 'grey', label: 'Not yet assessed' };
  if (assessed.length < expected) {
    return { level: 'grey', label: 'Partial assessment (' + assessed.length + '/' + expected + ')' };
  }

  let worstVerdict = 'ready';
  assessed.forEach(function (e) {
    if ((RANK[e.migrationReadinessVerdict] || 0) > (RANK[worstVerdict] || 0)) worstVerdict = e.migrationReadinessVerdict;
  });

  return { level: LEVELS[worstVerdict] || 'grey', label: LABELS[worstVerdict] || 'Unknown' };
}

module.exports = { rollupBatchReadiness, RANK, LABELS, LEVELS };
