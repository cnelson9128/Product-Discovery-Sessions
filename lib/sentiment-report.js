'use strict';

/*
 * Synthesizes one company-wide sentiment report for v2 — overall direction,
 * headline positive statements, and a per-module sentiment breakdown — from
 * every analyzed Product Discovery session (migration-readiness sessions are
 * excluded: this is about v2 value sentiment, not migration-readiness risk).
 * Sibling to lib/gtm-messaging.js, same input shape (each session's already-
 * extracted 11-question analysis, not the raw transcript) and the same
 * anti-fabrication design — see that file's header for the full reasoning,
 * which applies unchanged here: never write a client name into any output
 * text, only cite supporting_session_ids, which the frontend resolves to a
 * client/date chip from the session index.
 *
 * Built specifically to be screenshotted/printed into an exec/all-company
 * deck (see public/index.html's slide-styled rendering) — so sentiment must
 * be grounded strictly in what sessions actually established, never
 * optimistic rounding, since this is going in front of the company.
 *
 * Content exclusions: this report is shown company-wide, so some content is
 * kept out of it entirely regardless of what the underlying sessions say.
 * EXCLUDED_CLIENT_SUBSTRINGS names clients (case-insensitive substring
 * match against customerName, since the exact stored spelling may vary)
 * whose sessions should never feed this report at all —
 * api/sentiment-report-build.js filters their sessions out of the input
 * before it ever reaches the model, which is a stronger guarantee than
 * asking the model not to mention them. FORBIDDEN_TERMS are specific
 * topics/codenames that must never appear in any generated text; since
 * those can turn up in otherwise-unrelated sessions, that's enforced with a
 * system-prompt instruction plus a defensive post-generation scan
 * (containsForbiddenTerm) that fails the build rather than risk one
 * slipping through. To exclude another client or term later, add it to
 * these two lists and redeploy — there's no in-app UI for this by design,
 * since it's a rare, deliberate content-policy decision, not routine data.
 */

const modules = require('./modules');
const anthropicClient = require('./anthropic-client');

const MODEL = 'claude-opus-5';
const MAX_OUTPUT_TOKENS = 20000;
const REQUEST_TIMEOUT_MS = 290000;

const EXCLUDED_CLIENT_SUBSTRINGS = ['carmichael'];
const FORBIDDEN_TERMS = ['deep search'];

function isExcludedClient(customerName) {
  const name = String(customerName || '').toLowerCase();
  return EXCLUDED_CLIENT_SUBSTRINGS.some(function (s) { return name.includes(s); });
}

function containsForbiddenTerm(text) {
  const haystack = String(text || '').toLowerCase();
  return FORBIDDEN_TERMS.find(function (t) { return haystack.includes(t); }) || null;
}

/* Scans every generated text field for a forbidden term. Returns the first
   hit found as {field, term}, or null if the result is clean. */
function findForbiddenTermInResult(result) {
  const hit = containsForbiddenTerm(result.overall_narrative);
  if (hit) return { field: 'overall_narrative', term: hit };

  for (const h of result.headline_statements) {
    const quoteHit = containsForbiddenTerm(h.quote) || containsForbiddenTerm(h.theme);
    if (quoteHit) return { field: 'headline_statements', term: quoteHit };
  }
  for (const m of result.module_breakdown) {
    const summaryHit = containsForbiddenTerm(m.summary);
    if (summaryHit) return { field: 'module_breakdown', term: summaryHit };
  }
  return null;
}

const SENTIMENT_LEVELS = ['strongly_positive', 'positive', 'mixed', 'needs_attention'];
const MODULE_SENTIMENT_LEVELS = SENTIMENT_LEVELS.concat(['not_enough_signal']);
const supportedIds = { type: 'array', items: { type: 'string' } };

const SENTIMENT_SCHEMA = {
  type: 'object',
  properties: {
    overall_sentiment: { type: 'string', enum: SENTIMENT_LEVELS },
    overall_narrative: { type: 'string' },
    headline_statements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string' },
          theme: { type: 'string' },
          supporting_session_ids: supportedIds
        },
        required: ['quote', 'theme', 'supporting_session_ids'],
        additionalProperties: false
      }
    },
    module_breakdown: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          module: { type: 'string', enum: modules.MODULE_IDS },
          sentiment: { type: 'string', enum: MODULE_SENTIMENT_LEVELS },
          summary: { type: 'string' },
          supporting_session_ids: supportedIds
        },
        required: ['module', 'sentiment', 'summary', 'supporting_session_ids'],
        additionalProperties: false
      }
    }
  },
  required: ['overall_sentiment', 'overall_narrative', 'headline_statements', 'module_breakdown'],
  additionalProperties: false
};

const MODULE_LIST_PROSE = modules.MODULES.map(function (m) { return m.label; }).join(', ');

const SYSTEM_PROMPT = `You are a product research analyst for Firefish Software, a UK recruitment CRM,
building a sentiment report on v2 for an all-company presentation — the goal is to honestly show
where real customer sentiment sits and which direction it's trending, drawn from every Product
Discovery session run so far across all of its session types (${MODULE_LIST_PROSE}). Each input record
is one customer's already-extracted answers to the program's 11 standard discovery questions for one
session — not a raw transcript. This will be shown to the company, including non-product people, so it
must read as credible and grounded, not as marketing copy.

Produce:
- "overall_sentiment": one honest verdict for the whole program so far.
- "overall_narrative": a few sentences on where sentiment actually sits and what's driving it —
  specific themes that recurred, not generic positivity.
- "headline_statements": the standout, genuinely striking positive reactions worth quoting on their
  own slide — pulled from "value_created" statements and "one_sentence_pitch" answers.
- "module_breakdown": one entry per session type that has enough signal to say something real about —
  its own sentiment verdict and a short grounded summary.

Ground rules, non-negotiable:
- Never write a client or company name into any output text. You are given each session's client name
  only so you can reason about which distinct customers said what — never repeat one back in
  "overall_narrative", any "summary", or anywhere else. Refer to sessions only via
  "supporting_session_ids" — never inline a paraphrase that could be traced back to an individual
  customer's specific wording.
- Every item in "headline_statements" and "module_breakdown" must list the session ids that actually
  support it in "supporting_session_ids" — never include an item with zero supporting sessions, and
  never invent a session id that wasn't in the input.
- "headline_statements" works exactly like a module trend's "value_moments": each one is exactly ONE
  person's reaction — specific, enthusiastic, surprised, or strongly validating language about what v2
  makes possible, not a routine or lukewarm comment. "supporting_session_ids" must contain exactly the
  single session id that reaction came from — never combine reactions from different sessions into one
  statement, even if similar; list each as its own item instead. "quote" must paraphrase or quote what
  was actually said, cleaned of transcript noise, not restate "theme" in different words. If nothing
  rises to that level, return fewer items rather than stretching an ordinary comment into a headline.
- "overall_sentiment" and each module's "sentiment" must reflect the substance of what was actually
  said — weigh "trust_concerns" and "adoption_blockers" honestly against "value_created" and
  "one_sentence_pitch"; do not round up to a more positive verdict than the input supports just because
  this is going in front of the company. Use "needs_attention" when blockers/concerns genuinely
  outweigh the positives for that session type, not just when there's any friction at all — some
  friction alongside real value is "mixed" or even "positive", not automatically "needs_attention".
- Only include a session type in "module_breakdown" if it has at least one analyzed session AND gave
  you something concrete to say — use "sentiment":"not_enough_signal" for a session type with only one
  or two sessions and nothing distinctive yet, rather than omitting it outright or overstating a verdict
  off thin data; omit a session type entirely only if it has zero analyzed sessions.
- Do not editorialize about severity or priority beyond what the aggregated input actually supports.
- Never reference "Deep Search," or any other internal/unannounced feature codename, by name in any
  output field — if a session's input happens to mention one, write around it using only the
  general, already-public capability it relates to instead.`;

function buildUserContent(sessionInputs) {
  const payload = {
    sessionCount: sessionInputs.length,
    moduleCount: new Set(sessionInputs.map(function (s) { return s.module; })).size,
    sessions: sessionInputs
  };
  return 'Per-session discovery analysis across all session types follows as JSON:\n\n' +
    JSON.stringify(payload, null, 2);
}

/* sessionInputs: [{sessionId, clientName, sessionDate, module, analysis}, ...] — the caller
   (api/sentiment-report-build.js) is responsible for already having filtered out excluded clients
   via isExcludedClient before this is called. */
async function generateSentimentReport(sessionInputs) {
  const result = await anthropicClient.callStructured({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    schema: SENTIMENT_SCHEMA,
    userContent: buildUserContent(sessionInputs),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    effort: 'medium',
    timeoutMs: REQUEST_TIMEOUT_MS,
    schemaFileHint: 'lib/sentiment-report.js\'s MAX_OUTPUT_TOKENS'
  });

  const forbiddenHit = findForbiddenTermInResult(result.data);
  if (forbiddenHit) {
    const err = new Error(
      'The generated report referenced a forbidden term ("' + forbiddenHit.term + '") in ' +
      forbiddenHit.field + ' — discarded rather than shown. Try rebuilding.'
    );
    err.code = 'FORBIDDEN_TERM';
    throw err;
  }

  return { result: result.data, model: result.model, usage: result.usage };
}

module.exports = {
  generateSentimentReport,
  SENTIMENT_SCHEMA,
  SENTIMENT_LEVELS,
  MODULE_SENTIMENT_LEVELS,
  EXCLUDED_CLIENT_SUBSTRINGS,
  FORBIDDEN_TERMS,
  isExcludedClient,
  containsForbiddenTerm,
  findForbiddenTermInResult
};
