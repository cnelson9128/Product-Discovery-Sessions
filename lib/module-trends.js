'use strict';

/*
 * Synthesizes a module-level trend — feature prioritization (now/later/
 * future), adoption blockers, and go-to-market messaging — from every
 * already-analyzed session tagged to that module. Takes each session's
 * already-extracted 11-question `analysis` object as input, not the raw
 * transcript: a few hundred words per session versus up to 120k characters,
 * so even the ~15-20 sessions one module might accumulate over the program
 * stays well within budget, and it builds on analysis that has already been
 * fabrication-checked once rather than re-deriving it from many transcripts
 * at once.
 *
 * Deliberately never asks the model to write a client name into any output
 * text — every item instead cites `supporting_session_ids`, which the
 * frontend resolves to a client/date chip from the session index (data it
 * already trusts) rather than from model recall. This removes a real
 * attribution-error risk once synthesizing across many sessions, and makes
 * GTM messaging drafts structurally incapable of leaking a client name into
 * copy that might get reused externally.
 */

const anthropicClient = require('./anthropic-client');

const MODEL = 'claude-opus-5';
const MAX_OUTPUT_TOKENS = 16000;
const REQUEST_TIMEOUT_MS = 290000;

const supportedIds = { type: 'array', items: { type: 'string' } };

const TREND_SCHEMA = {
  type: 'object',
  properties: {
    overview_summary: { type: 'string' },
    feature_prioritization: {
      type: 'object',
      properties: {
        now: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string' },
              rationale: { type: 'string' },
              supporting_session_ids: supportedIds
            },
            required: ['item', 'rationale', 'supporting_session_ids'],
            additionalProperties: false
          }
        },
        later: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string' },
              rationale: { type: 'string' },
              supporting_session_ids: supportedIds
            },
            required: ['item', 'rationale', 'supporting_session_ids'],
            additionalProperties: false
          }
        },
        future: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string' },
              rationale: { type: 'string' },
              supporting_session_ids: supportedIds
            },
            required: ['item', 'rationale', 'supporting_session_ids'],
            additionalProperties: false
          }
        }
      },
      required: ['now', 'later', 'future'],
      additionalProperties: false
    },
    adoption_blockers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          blocker: { type: 'string' },
          impact: { type: 'string' },
          supporting_session_ids: supportedIds
        },
        required: ['blocker', 'impact', 'supporting_session_ids'],
        additionalProperties: false
      }
    },
    gtm_messaging: {
      type: 'object',
      properties: {
        positioning_statement: { type: 'string' },
        value_pillars: {
          type: 'array',
          items: {
            type: 'object',
            properties: { pillar: { type: 'string' }, evidence_theme: { type: 'string' } },
            required: ['pillar', 'evidence_theme'],
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
      required: ['positioning_statement', 'value_pillars', 'draft_messages'],
      additionalProperties: false
    }
  },
  required: ['overview_summary', 'feature_prioritization', 'adoption_blockers', 'gtm_messaging'],
  additionalProperties: false
};

function buildSystemPrompt(moduleLabel) {
  return `You are a product research analyst for Firefish Software, a UK recruitment CRM, synthesizing
discovery-call findings for the v2 "${moduleLabel}" module across every customer session run for it
so far. Each input record is one customer's already-extracted answers to the program's 11 standard
discovery questions (today's process, value created, who benefits, adoption blockers, v1 comparison,
trust concerns, migration blockers, migration conditions, top priority improvement, success metric,
one-sentence pitch) — not a raw transcript.

Produce: a short overview, feature prioritization split into now / later / future, a consolidated
list of adoption blockers, and draft go-to-market messaging.

Ground rules, non-negotiable:
- Never write a client or company name into any output text. You are given each session's client
  name only so you can reason about which distinct customers said what — never repeat one back in
  "overview_summary", any "rationale"/"impact", or anywhere in "gtm_messaging". Refer to sessions
  only via their "supporting_session_ids" — never inline a paraphrase like "one client said" that
  could be traced back to an individual customer's specific wording.
- Every item in "now", "later", "future", and "adoption_blockers" must list the session ids that
  actually support it in "supporting_session_ids" — never include an item with zero supporting
  sessions, and never invent a session id that wasn't in the input.
- Only place an item in "now" if multiple sessions' structured answers actually support urgency —
  a shared adoption blocker, a repeated "business-critical missing" item, or a repeated top-priority
  improvement. Do not promote something to "now" just because it seems generally important for this
  module — that is what "later" or "future" are for, or omit it if the input doesn't support it.
- If the input sessions give too little signal for a field — for example, no one raised any
  business-critical migration blockers — return an empty list rather than inventing generic filler.
- "gtm_messaging" must be grounded in themes that actually recurred across the input sessions, not
  generic recruitment-software marketing copy that would apply regardless of what these specific
  customers said.
- Do not editorialize about severity or priority beyond what the aggregated input supports.`;
}

function buildUserContent(moduleLabel, sessionInputs) {
  const payload = {
    module: moduleLabel,
    sessionCount: sessionInputs.length,
    sessions: sessionInputs
  };
  return 'Per-session discovery analysis for this module follows as JSON:\n\n' +
    JSON.stringify(payload, null, 2);
}

/* sessionInputs: [{sessionId, clientName, sessionDate, analysis}, ...] */
async function generateTrend(moduleLabel, sessionInputs) {
  const result = await anthropicClient.callStructured({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    systemPrompt: buildSystemPrompt(moduleLabel),
    schema: TREND_SCHEMA,
    userContent: buildUserContent(moduleLabel, sessionInputs),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    effort: 'medium',
    timeoutMs: REQUEST_TIMEOUT_MS,
    schemaFileHint: 'lib/module-trends.js\'s MAX_OUTPUT_TOKENS'
  });
  return { result: result.data, model: result.model, usage: result.usage };
}

module.exports = { generateTrend, TREND_SCHEMA };
