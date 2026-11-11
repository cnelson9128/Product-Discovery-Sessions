'use strict';

/*
 * Matches shipped commits in another codebase ("Moon") to open feature cards
 * on this app's roadmap board, so scripts/moon-ticket-sync.js can mark a
 * card complete once its request has genuinely been built — without
 * requiring an explicit ticket id on the card (see lib/store.js's
 * `linkedTicket`-based fast path, which still runs first and needs no AI).
 *
 * Reused directly by scripts/moon-ticket-sync.js via a relative require —
 * this only has an opinion on "what matches what," not on how commits are
 * gathered or what happens to a match once it comes back (that's the
 * script's job, since only it knows the confidence-gating policy).
 *
 * Same anti-overclaiming discipline as the rest of this app's synthesis
 * prompts: a card only gets marked complete off a "high" confidence match,
 * and the prompt is explicit that "high" carries that real consequence —
 * this is production roadmap data feeding the Sentiment Report and exec
 * reporting, so a vague thematic resemblance must never be enough.
 */

const anthropicClient = require('./anthropic-client');

const MODEL = 'claude-opus-5';
const MAX_OUTPUT_TOKENS = 12000;
const REQUEST_TIMEOUT_MS = 290000;
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          feature_card_id: { type: 'string' },
          confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
          reason: { type: 'string' },
          evidence_commit_shas: { type: 'array', items: { type: 'string' } }
        },
        required: ['feature_card_id', 'confidence', 'reason', 'evidence_commit_shas'],
        additionalProperties: false
      }
    }
  },
  required: ['matches'],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are matching shipped code changes in Firefish's v2 "Moon" codebase to open
feature requests tracked on a separate product roadmap board, so a card can be marked complete
automatically once its request has genuinely been built.

You'll be given: (1) a list of open feature cards, each with an id, the product module it's filed
under, a short "item" description, and a "rationale"; (2) a batch of recent commits, each with its
sha, commit message, changed file list, and a (possibly truncated) diff.

For each feature card you're confident has actually been delivered by one or more of the given
commits, return a match citing the commit sha(s) that justify it and an honest confidence level. A
single commit can satisfy more than one card, and a single card's match can cite more than one
commit.

Ground rules, non-negotiable:
- Only return a match when the commit(s) genuinely implement what the card describes — matching on
  vague thematic similarity (same module, similar-sounding words) is not enough. The commit must
  actually build the specific thing the card asks for.
- "confidence":"high" only when you're confident enough that this would be safe to mark complete
  without a human double-checking it first — the code clearly and specifically implements the card's
  request, not just something in the same area. Use "medium" or "low" whenever there's real doubt
  (a partial implementation, an ambiguous scope, a plausible but not certain match) — being marked
  complete without review is a real consequence of "high", so don't default to it just because
  something looks related.
- Never invent a feature_card_id or commit sha that wasn't given to you in the input.
- Most commits won't match any open card, and most cards won't match any commit in a given batch —
  that's expected, not a failure. Only return genuine matches.
- "reason" is one or two sentences a human can use to sanity-check the match without re-reading the
  diff themselves — name what the commit actually does, not just "this looks related."`;

function buildUserContent(openCards, commits) {
  const payload = { open_feature_cards: openCards, commits: commits };
  return 'Open feature cards and recent commits follow as JSON:\n\n' + JSON.stringify(payload, null, 2);
}

/* openCards: [{id, module, item, rationale}], commits: [{sha, message, files, diff}].
   Returns [] without calling the model at all if either list is empty — no
   cards to match against, or nothing new to check. */
async function matchCommitsToCards(openCards, commits) {
  if (!openCards.length || !commits.length) return [];
  const result = await anthropicClient.callStructured({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    schema: MATCH_SCHEMA,
    userContent: buildUserContent(openCards, commits),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    effort: 'medium',
    timeoutMs: REQUEST_TIMEOUT_MS,
    schemaFileHint: 'lib/moon-match.js\'s MAX_OUTPUT_TOKENS'
  });
  return result.data.matches;
}

module.exports = { matchCommitsToCards, MATCH_SCHEMA, CONFIDENCE_LEVELS };
