'use strict';

/*
 * Extracts a migration-readiness risk profile from one migration-readiness
 * session's transcript: an overall readiness verdict, themed risk areas with
 * severity, concrete blockers, and whether the customer's own signal
 * supports the batch's target migration date. Runs alongside
 * lib/analysis.js's 11-question analysis and lib/raised-items.js's
 * extraction (all three in parallel, from api/sessions-analyze.js) — only
 * for sessions on the migration-readiness track.
 *
 * Framed around the batch's actual definition text, not the customer's name
 * or module: the interviewer is validating whether THIS customer is ready
 * for exactly the scope that batch covers (e.g. "perm workflow only, Gmail/
 * Microsoft365 integrations only") — a risk area or blocker outside that
 * scope isn't this batch's problem to carry.
 *
 * Same anti-fabrication rule as lib/raised-items.js: risk profiles from many
 * customers get read side by side on one batch's page for exec reporting, so
 * a client/company name must never land in generated text.
 */

const anthropicClient = require('./anthropic-client');

const MODEL = 'claude-opus-5';
const MAX_OUTPUT_TOKENS = 10000;
const REQUEST_TIMEOUT_MS = 290000;

const RISK_THEMES = ['technical_integration', 'data_migration', 'training_change_management', 'timeline', 'commercial_contractual', 'other'];
const SEVERITIES = ['low', 'medium', 'high'];
const READINESS_VERDICTS = ['ready', 'minor_concerns', 'major_concerns', 'not_ready'];
const DATE_VERDICTS = ['on_track', 'at_risk', 'not_discussed'];

const MIGRATION_RISK_SCHEMA = {
  type: 'object',
  properties: {
    overall_readiness: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: READINESS_VERDICTS },
        explanation: { type: 'string' }
      },
      required: ['verdict', 'explanation'],
      additionalProperties: false
    },
    risk_areas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          theme: { type: 'string', enum: RISK_THEMES },
          severity: { type: 'string', enum: SEVERITIES },
          description: { type: 'string' },
          evidence: { type: 'string' }
        },
        required: ['theme', 'severity', 'description', 'evidence'],
        additionalProperties: false
      }
    },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { blocker: { type: 'string' }, evidence: { type: 'string' } },
        required: ['blocker', 'evidence'],
        additionalProperties: false
      }
    },
    target_date_feasibility: {
      type: 'object',
      properties: {
        mentioned: { type: 'boolean' },
        verdict: { type: 'string', enum: DATE_VERDICTS },
        explanation: { type: 'string' }
      },
      required: ['mentioned', 'verdict', 'explanation'],
      additionalProperties: false
    }
  },
  required: ['overall_readiness', 'risk_areas', 'blockers', 'target_date_feasibility'],
  additionalProperties: false
};

function buildSystemPrompt(batchLabel, batchDescription) {
  return `You are a migration-readiness analyst for Firefish Software, a UK recruitment CRM, assessing
whether one customer is genuinely ready to migrate to v2 under "${batchLabel}" — a fixed migration
scope defined as: "${batchDescription}". This is not a general product-discovery call; the interviewer
is specifically validating this customer's readiness to move under exactly that scope, and every risk
area or blocker you extract should be about what stands between this customer and a safe migration,
not general product feedback (unrelated feature requests still matter — they're captured separately by
this program's feature-extraction pass, not here).

Ground rules, non-negotiable:
- Never write the customer's name or company name into any output text — "explanation", "description",
  or "evidence" fields. Risk profiles from many customers get read side by side on one batch's page for
  exec reporting; refer to "the customer" or "they" if a subject is needed at all.
- "overall_readiness.verdict" must reflect the substance of what was actually said — reserve "ready"
  for a call with no material blockers or unresolved concerns raised; "not_ready" for one where the
  customer raised something that would genuinely stop this migration going ahead as scoped. Do not
  default to a middle verdict out of caution — pick the one the transcript actually supports.
- "risk_areas" — only include a risk actually raised or clearly implied by what the customer said; use
  "severity":"high" only for something that would block or seriously jeopardize migration if unresolved,
  not routine hesitation. Return an empty list if nothing rises to the level of a real risk area.
- "blockers" is for concrete, specific things that must be resolved before this customer can migrate —
  the same evidence-grounded shape as the rest of this program's extraction (never invent one).
- "target_date_feasibility": set "mentioned":false and "verdict":"not_discussed" unless the interviewer
  and customer actually discussed a target migration date and whether it's achievable — do not infer
  feasibility from unrelated risk signals alone.
- Do not editorialize about severity or priority beyond what the transcript actually supports.`;
}

function normalizeText(s, maxLen) {
  const str = String(s || '');
  return str.length > maxLen ? str.slice(0, maxLen) + '\n\n[truncated]' : str;
}

function buildUserContent(session, batchLabel) {
  const payload = {
    session: {
      batch: batchLabel,
      customerName: session.customerName,
      interviewer: session.interviewer,
      participants: session.participants || null,
      sessionDate: session.sessionDate
    },
    transcript: normalizeText(session.transcript, 120000)
  };
  return 'Migration-readiness session details and transcript follow as JSON:\n\n' + JSON.stringify(payload, null, 2);
}

async function generateMigrationRisk(session, batchLabel, batchDescription) {
  const result = await anthropicClient.callStructured({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    systemPrompt: buildSystemPrompt(batchLabel, batchDescription),
    schema: MIGRATION_RISK_SCHEMA,
    userContent: buildUserContent(session, batchLabel),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    effort: 'medium',
    timeoutMs: REQUEST_TIMEOUT_MS,
    schemaFileHint: 'lib/migration-risk.js\'s MAX_OUTPUT_TOKENS'
  });
  return { migrationRisk: result.data, model: result.model, usage: result.usage };
}

module.exports = {
  generateMigrationRisk,
  MIGRATION_RISK_SCHEMA,
  RISK_THEMES,
  SEVERITIES,
  READINESS_VERDICTS,
  DATE_VERDICTS
};
