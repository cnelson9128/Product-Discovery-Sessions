'use strict';

/*
 * The board shape a module trend's feature prioritization is persisted and
 * edited as, once it leaves the model.
 *
 * lib/module-trends.js still asks the model for now/later/future — that's
 * just its internal generation vocabulary, and a sensible one for an LLM to
 * reason in. What gets persisted (api/module-trends-build.js) and shown on
 * the board is a flat list of cards, each carrying a stable `id` and a
 * mutable `bucket` (launch/phase2/bau — this program's actual terminology)
 * and `complete` flag, since those two fields are user-editable after the
 * fact (api/module-trends-card.js), and a flat list with a bucket field per
 * card is what makes "move this card to a different bucket" a one-field
 * update instead of splicing between three separate arrays.
 *
 * Rebuilding a trend regenerates every card from scratch with fresh ids, so
 * manual bucket moves and completions from a previous build do not carry
 * forward — the frontend warns about this before a refresh (not before the
 * first build, when there's nothing yet to lose).
 */

const crypto = require('crypto');

const BUCKETS = ['launch', 'phase2', 'bau'];

function isValidBucket(bucket) {
  return BUCKETS.indexOf(bucket) >= 0;
}

/* result is the raw model output — {feature_prioritization: {now, later, future}, ...} */
function toCards(result) {
  const fp = (result && result.feature_prioritization) || {};
  const fromArray = function (arr, bucket) {
    return (arr || []).map(function (it) {
      return {
        id: crypto.randomUUID(),
        item: it.item,
        rationale: it.rationale,
        supporting_session_ids: it.supporting_session_ids || [],
        bucket: bucket,
        complete: false
      };
    });
  };
  return [].concat(fromArray(fp.now, 'launch'), fromArray(fp.later, 'phase2'), fromArray(fp.future, 'bau'));
}

/* Recomputed after every build and every manual move/complete, so the
   Status Report's numbers are always current without it needing to know
   anything about card shape itself. */
function boardCounts(cards) {
  const list = cards || [];
  return {
    launch: list.filter(function (c) { return c.bucket === 'launch'; }).length,
    phase2: list.filter(function (c) { return c.bucket === 'phase2'; }).length,
    bau: list.filter(function (c) { return c.bucket === 'bau'; }).length,
    total: list.length,
    complete: list.filter(function (c) { return c.complete; }).length
  };
}

module.exports = { BUCKETS, isValidBucket, toCards, boardCounts };
