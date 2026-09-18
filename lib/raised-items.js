'use strict';

/*
 * Extracts every discrete feature, problem, request, or opportunity raised in
 * one session's transcript and classifies each by the product module its
 * content is actually about — deliberately independent of which module this
 * session itself is tagged with. Kept as its own call, separate from
 * lib/analysis.js's 11-question extraction, for two reasons: it must scan
 * for content that may have nothing to do with this session's own topic
 * (an off-topic classification bias is exactly what a combined prompt would
 * risk), and it must never put the already-tuned 11-question prompt/schema
 * at risk of drift as a side effect of this feature.
 *
 * Runs in parallel with lib/analysis.js's call from api/sessions-analyze.js
 * (both only need the transcript, no dependency on each other), so this adds
 * no wall-clock cost to session analysis.
 *
 * Same anti-fabrication rule as lib/module-trends.js: never let a client
 * name land in generated text. Items from many customers end up pooled
 * together on one module's shared board, so that's not just a synthesis-time
 * concern here — it applies to a single session's extraction too.
 */

const anthropicClient = require('./anthropic-client');
const moduleClassification = require('./module-classification');

const MODEL = 'claude-opus-5';
const MAX_OUTPUT_TOKENS = 12000;
const REQUEST_TIMEOUT_MS = 290000;

const RAISED_ITEM_SCHEMA = {
  type: 'object',
  properties: Object.assign(
    {
      item: { type: 'string' },
      rationale: { type: 'string' },
      evidence: { type: 'string' }
    },
    moduleClassification.CLASSIFICATION_FIELDS
  ),
  required: ['item', 'rationale', 'evidence', 'primary_module', 'secondary_modules', 'confidence', 'classification_reason'],
  additionalProperties: false
};

const RAISED_ITEMS_SCHEMA = {
  type: 'object',
  properties: {
    raised_items: { type: 'array', items: RAISED_ITEM_SCHEMA }
  },
  required: ['raised_items'],
  additionalProperties: false
};

function buildSystemPrompt(moduleLabel) {
  return `You are a product analyst for Firefish Software, a UK recruitment CRM, mining one customer
discovery-call transcript for every discrete feature idea, problem, complaint, request, or opportunity
that was raised — regardless of whether it relates to this session's own topic. This session was
nominally about "${moduleLabel}", but customers routinely raise feedback about other parts of the
platform during a call about something else — a Search & Match complaint mentioned mid-way through a
Job Workflows or Introduction session is just as real and just as important to capture. Your job is to
find every one of those items and file each under the ONE product module its content and intended
outcome is actually about.

${moduleClassification.buildClassificationRulesText()}

Ground rules, non-negotiable:
- Never default an item to "${moduleLabel}" just because that is this session's own topic. Classify
  purely on what the item itself is about — the session's topic is context, not a classification
  shortcut. Most items in a session about one module will genuinely belong to that module, but that
  must be a conclusion you reach by matching the item against the module definitions, not an assumption
  you start from.
- Every item must be something the customer (or their team) actually raised — never invent one, even a
  plausible one. If the transcript raises nothing that fits this shape, return an empty array rather
  than manufacturing filler.
- "item" is a concise statement of the feature/problem/request itself. "rationale" is why it matters or
  what outcome it's meant to produce. "evidence" paraphrases or quotes what was actually said, cleaned
  of transcript noise (no timestamps, no "yeah, yeah, so", no garbled names) — it must not restate
  "item" in different words.
- Treat each distinct idea as its own item, even if two ideas were raised close together in the
  conversation — do not merge unrelated asks into one item to keep the list short.
- Do not extract routine process narration (e.g. "we currently use spreadsheets") as an item unless the
  customer is actually asking for or reacting to a specific capability. This is about actionable
  feedback, not a restatement of today's process.
- One primary module per item. Only add a secondary module when the item genuinely serves two modules'
  outcomes at once — most items have none (empty array). Use "confidence": "low" whenever the item could
  plausibly fit more than one module about equally well; this is expected to happen sometimes and is not
  a failure, it flags the item for a human to glance at rather than trusting the call blindly.
- Never write the customer's name or company name into "item", "rationale", or "evidence" — these
  items get pooled onto a shared roadmap board across every module and every customer, and the
  session it came from is already tracked separately. Refer to the customer as "the customer" or
  "they" if a subject is needed at all.`;
}

function normalizeText(s, maxLen) {
  const str = String(s || '');
  return str.length > maxLen ? str.slice(0, maxLen) + '\n\n[truncated]' : str;
}

function buildUserContent(session, moduleLabel) {
  const payload = {
    session: {
      module: moduleLabel,
      customerName: session.customerName,
      interviewer: session.interviewer,
      participants: session.participants || null,
      sessionDate: session.sessionDate
    },
    transcript: normalizeText(session.transcript, 120000)
  };
  return 'Discovery session details and transcript follow as JSON:\n\n' + JSON.stringify(payload, null, 2);
}

async function extractRaisedItems(session, moduleLabel) {
  const result = await anthropicClient.callStructured({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    systemPrompt: buildSystemPrompt(moduleLabel),
    schema: RAISED_ITEMS_SCHEMA,
    userContent: buildUserContent(session, moduleLabel),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    effort: 'medium',
    timeoutMs: REQUEST_TIMEOUT_MS,
    schemaFileHint: 'lib/raised-items.js\'s MAX_OUTPUT_TOKENS'
  });
  return { raisedItems: result.data.raised_items, model: result.model, usage: result.usage };
}

module.exports = { extractRaisedItems, RAISED_ITEMS_SCHEMA };
