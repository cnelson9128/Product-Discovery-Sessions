'use strict';

/*
 * Synthesizes one company-wide go-to-market view from every analyzed
 * session across all 10 modules — the layer above lib/module-trends.js,
 * which only ever looks at one module at a time. Same input shape (each
 * session's already-extracted 11-question analysis, not the raw transcript)
 * and the same anti-fabrication design: the model is never asked to write a
 * client name into any output text, only to cite `supporting_session_ids`,
 * which the frontend resolves to a client/date chip from the session index
 * — see lib/module-trends.js's header for the full reasoning, which applies
 * unchanged here.
 */

const modules = require('./modules');
const anthropicClient = require('./anthropic-client');

const MODEL = 'claude-opus-5';
/* Higher than lib/module-trends.js's 16000 — this synthesizes across every
   module at once rather than one, so the arrays (value pillars, proof
   points, objections, per-module highlights) can genuinely be larger. Watch
   stop_reason for 'max_tokens' and raise further if it fires. */
const MAX_OUTPUT_TOKENS = 24000;
const REQUEST_TIMEOUT_MS = 290000;

const supportedIds = { type: 'array', items: { type: 'string' } };

const GTM_SCHEMA = {
  type: 'object',
  properties: {
    overview_summary: { type: 'string' },
    positioning_statement: { type: 'string' },
    value_pillars: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pillar: { type: 'string' },
          evidence_theme: { type: 'string' },
          supporting_session_ids: supportedIds
        },
        required: ['pillar', 'evidence_theme', 'supporting_session_ids'],
        additionalProperties: false
      }
    },
    proof_points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          evidence_theme: { type: 'string' },
          supporting_session_ids: supportedIds
        },
        required: ['claim', 'evidence_theme', 'supporting_session_ids'],
        additionalProperties: false
      }
    },
    objection_handling: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          objection: { type: 'string' },
          response: { type: 'string' },
          supporting_session_ids: supportedIds
        },
        required: ['objection', 'response', 'supporting_session_ids'],
        additionalProperties: false
      }
    },
    module_highlights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          module: { type: 'string', enum: modules.MODULE_IDS },
          headline: { type: 'string' },
          supporting_session_ids: supportedIds
        },
        required: ['module', 'headline', 'supporting_session_ids'],
        additionalProperties: false
      }
    },
    draft_messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: { audience: { type: 'string' }, message: { type: 'string' } },
        required: ['audience', 'message'],
        additionalProperties: false
      }
    }
  },
  required: [
    'overview_summary', 'positioning_statement', 'value_pillars', 'proof_points',
    'objection_handling', 'module_highlights', 'draft_messages'
  ],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are a product marketing analyst for Firefish Software, a UK recruitment CRM,
building the overall go-to-market narrative for the v2 product from every discovery-call session
run across the whole research program so far — spanning all of its modules (Job Workflows, Search &
Match, Conversations, Business Development & Marketing, Analytics & Reporting, Portals, Pay & Bill,
Agents / AI & Automation, Multiposting, Websites). Each input record is one customer's already-
extracted answers to the program's 11 standard discovery questions for one module — not a raw
transcript.

Produce: an overview, one overall positioning statement for v2 as a whole, the value pillars that
recur across modules and customers, concrete proof points (measurable outcomes or comparisons
customers actually described), objection handling (built from adoption blockers and trust concerns
customers actually raised), a one-line value highlight per module that has enough signal to support
one, and draft messages for different audiences.

Ground rules, non-negotiable:
- Never write a client or company name into any output text. You are given each session's client
  name only so you can reason about which distinct customers said what — never repeat one back in
  any field. Refer to sessions only via "supporting_session_ids" — never inline a paraphrase that
  could be traced back to an individual customer's specific wording.
- Every item in "value_pillars", "proof_points", "objection_handling", and "module_highlights" must
  list the session ids that actually support it in "supporting_session_ids" — never include an item
  with zero supporting sessions, and never invent a session id that wasn't in the input.
- A value pillar or proof point should recur across more than one session or module to count as
  company-wide messaging — a single customer's one-off comment is better suited to that module's own
  trend view (built separately) than to this overall narrative. Do not promote something to this
  level just because it sounds like good marketing copy.
- Only include a module in "module_highlights" if its sessions actually gave you something concrete
  to say — omit a module entirely rather than inventing a generic highlight for it.
- "objection_handling" responses must be grounded in what the aggregated input actually supports —
  real mitigations, workarounds, or context customers themselves gave, not generic reassurance.
- Do not editorialize about severity or priority beyond what the aggregated input supports.
- This is marketing collateral that may be reused externally — nothing here should overstate what
  the underlying sessions actually established.`;

function buildUserContent(sessionInputs) {
  const payload = {
    sessionCount: sessionInputs.length,
    moduleCount: new Set(sessionInputs.map(function (s) { return s.module; })).size,
    sessions: sessionInputs
  };
  return 'Per-session discovery analysis across all modules follows as JSON:\n\n' +
    JSON.stringify(payload, null, 2);
}

/* sessionInputs: [{sessionId, clientName, sessionDate, module, analysis}, ...] */
async function generateGtm(sessionInputs) {
  const result = await anthropicClient.callStructured({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    schema: GTM_SCHEMA,
    userContent: buildUserContent(sessionInputs),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    effort: 'medium',
    timeoutMs: REQUEST_TIMEOUT_MS,
    schemaFileHint: 'lib/gtm-messaging.js\'s MAX_OUTPUT_TOKENS'
  });
  return { result: result.data, model: result.model, usage: result.usage };
}

module.exports = { generateGtm, GTM_SCHEMA };
