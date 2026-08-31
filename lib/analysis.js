'use strict';

/*
 * Turns a product-discovery-call transcript into structured answers to the
 * program's 11 standard validation questions (see the field-by-field
 * comments in ANALYSIS_SCHEMA below). No HTTP request handling here — that's
 * api/sessions-analyze.js's job — this module only knows how to build the
 * prompt and call the model, via the shared lib/anthropic-client.js.
 */

const anthropicClient = require('./anthropic-client');

const MODEL = 'claude-opus-5';
/* max_tokens covers thinking AND the visible response combined. Watch
   stop_reason for 'max_tokens' on early real runs — the schema has 12
   top-level fields, several of them arrays of {evidence-bearing} objects —
   and raise this if it fires. */
const MAX_OUTPUT_TOKENS = 16000;
/* Vercel's Fluid Compute allows up to 300s even on Hobby (vercel.json sets
   this function's maxDuration to match) — leave a buffer under that so this
   timeout fires with a clear message instead of Vercel killing the function
   outright. Streaming avoids the class of bug where a non-streaming call
   commits to (and bills for) a generation that an idle-connection timeout
   then kills before the result comes back. */
const REQUEST_TIMEOUT_MS = 290000;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    /* Q1: before this capability, how did it work today, and where does that process break down? */
    today_process: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        breakdown_points: {
          type: 'array',
          items: {
            type: 'object',
            properties: { point: { type: 'string' }, evidence: { type: 'string' } },
            required: ['point', 'evidence'],
            additionalProperties: false
          }
        }
      },
      required: ['summary', 'breakdown_points'],
      additionalProperties: false
    },
    /* Q2: what value does this create for the agency? */
    value_created: {
      type: 'object',
      properties: {
        statements: {
          type: 'array',
          items: {
            type: 'object',
            properties: { value: { type: 'string' }, evidence: { type: 'string' } },
            required: ['value', 'evidence'],
            additionalProperties: false
          }
        }
      },
      required: ['statements'],
      additionalProperties: false
    },
    /* Q3: which users benefit most, and which see little or negative value? */
    user_impact: {
      type: 'object',
      properties: {
        benefits_most: {
          type: 'array',
          items: {
            type: 'object',
            properties: { user_group: { type: 'string' }, evidence: { type: 'string' } },
            required: ['user_group', 'evidence'],
            additionalProperties: false
          }
        },
        limited_or_negative_value: {
          type: 'array',
          items: {
            type: 'object',
            properties: { user_group: { type: 'string' }, evidence: { type: 'string' } },
            required: ['user_group', 'evidence'],
            additionalProperties: false
          }
        }
      },
      required: ['benefits_most', 'limited_or_negative_value'],
      additionalProperties: false
    },
    /* Q4: what would prevent user adoption? */
    adoption_blockers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { blocker: { type: 'string' }, evidence: { type: 'string' } },
        required: ['blocker', 'evidence'],
        additionalProperties: false
      }
    },
    /* Q5: how does this differ from v1 — better, worse, or simply different? */
    v1_comparison: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['better', 'worse', 'different', 'mixed', 'not_discussed'] },
        explanation: { type: 'string' }
      },
      required: ['verdict', 'explanation'],
      additionalProperties: false
    },
    /* Q6: does anything feel unclear, incomplete, or difficult to trust? */
    trust_concerns: {
      type: 'array',
      items: {
        type: 'object',
        properties: { concern: { type: 'string' }, evidence: { type: 'string' } },
        required: ['concern', 'evidence'],
        additionalProperties: false
      }
    },
    /* Q7: is anything business-critical missing that would prevent migration or adoption? */
    migration_blockers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'string' }, evidence: { type: 'string' } },
        required: ['item', 'evidence'],
        additionalProperties: false
      }
    },
    /* Q8: what would need to be true to move this workflow from v1 to v2? */
    migration_conditions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { condition: { type: 'string' }, evidence: { type: 'string' } },
        required: ['condition', 'evidence'],
        additionalProperties: false
      }
    },
    /* Q9: if only one improvement could land before migration, which one, and why? */
    top_priority_improvement: {
      type: 'object',
      properties: {
        mentioned: { type: 'boolean' },
        improvement: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['mentioned', 'improvement', 'reason'],
      additionalProperties: false
    },
    /* Q10: what measurable change would this prove within the business? */
    success_metric: {
      type: 'object',
      properties: {
        mentioned: { type: 'boolean' },
        metric: { type: 'string' },
        evidence: { type: 'string' }
      },
      required: ['mentioned', 'metric', 'evidence'],
      additionalProperties: false
    },
    /* Q11: how would you explain the value of this to a colleague in one sentence? */
    one_sentence_pitch: {
      type: 'object',
      properties: {
        mentioned: { type: 'boolean' },
        text: { type: 'string' }
      },
      required: ['mentioned', 'text'],
      additionalProperties: false
    },
    /* The analyst's own gist of the whole call, for the dashboard table — distinct from
       one_sentence_pitch, which must stay in the customer's own voice/framing. */
    overall_summary: { type: 'string' }
  },
  required: [
    'today_process', 'value_created', 'user_impact', 'adoption_blockers', 'v1_comparison',
    'trust_concerns', 'migration_blockers', 'migration_conditions', 'top_priority_improvement',
    'success_metric', 'one_sentence_pitch', 'overall_summary'
  ],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You are a product research analyst for Firefish Software, a UK recruitment CRM.
A product manager or researcher has just run a discovery interview with a customer about their v2
product, with this session focused on "{{MODULE_LABEL}}" — this is not a sales call, and there is no
demo or deal to prepare for. The interviewer asks (in their own words, not necessarily verbatim) the
same 11 standard questions on every call, whether the session covers one specific capability or is a
broader introduction to the product as a whole:

1. Before this capability, how did it work today? Where does that process break down?
2. What value does this create for your recruitment agency?
3. Which users would benefit the most, and which users may see little or negative value?
4. What would prevent user adoption?
5. How does this differ from v1 — is it better, worse, or simply different?
6. Does anything feel unclear, incomplete, or difficult to trust?
7. Is there anything business-critical missing that would prevent migration or adoption?
8. What would need to be true for you to move this workflow from v1 to v2?
9. If only one improvement could land before migration, which one would it be, and why?
10. What measurable change would this prove within your business?
11. How would you explain the value of this to a colleague in one sentence?

Produce one structured answer per question, grounded only in what was actually said.

The transcript is raw output from auto-transcription software (Fireflies, Otter or similar), not a
cleaned-up document. Expect, and handle without complaint:
- Line-leading timestamps (e.g. "04:32") — ignore them, they carry no content.
- Generic or missing speaker labels, most commonly "Unknown user" for whichever party the
  transcriber couldn't identify. Work out who is who from what's actually said (the interviewer
  asks the 11 questions above; the customer describes their own team, systems and pain points), and
  use the "participants" field given below as a hint — names are often said aloud mid-call, which
  helps confirm who is who.
- Transcription noise: false starts, filler ("yeah, yeah, so, so"), stutters, words repeated or
  dropped, and misheard proper nouns. Paraphrase cleanly using correct names rather than quoting
  the garbled version back.
- Multiple people speaking on one side (e.g. two people from the customer's team) — attribute each
  by name where the transcript gives one, and don't conflate what different individuals said.

Ground rules, non-negotiable:
- Every field must be something the customer (or their team) actually said — never invent one, even
  a plausible one, because it seems like a natural thing a customer in this situation would say.
  This applies to every one of the 11 fields, not just the list-shaped ones.
- List-shaped fields (breakdown_points, value statements, user_impact groups, adoption_blockers,
  trust_concerns, migration_blockers, migration_conditions) use an empty array when nothing was
  raised for that question — never invent generic filler to avoid an empty list.
- "evidence" fields must paraphrase or quote what was actually said on the call, not restate the
  label next to it — and should read as clean prose, not transcript noise (no timestamps, no
  "yeah, yeah, so", no garbled names).
- For v1_comparison: only use "better", "worse", "different" or "mixed" if the customer actually
  drew a comparison to how this works in v1 today. If they only praised or criticized v2 in
  isolation, without comparing it to v1, that is "not_discussed" — do not assume a comparison was
  implied. Use "mixed" only if they said it is better in some ways and worse in others.
- For top_priority_improvement, success_metric, and one_sentence_pitch: if the customer did not
  give a substantive answer to that specific question — they deflected, said they didn't know, or
  the transcript never reaches that question — set "mentioned" to false and leave the accompanying
  text fields as an empty string. Do not infer a plausible answer from the rest of the call.
- Do not editorialize about severity or priority beyond what the customer's own words support.
- Keep everything specific to this call. An answer that would apply to any customer conversation
  about this module is a failure.`;

function normalizeText(s, maxLen) {
  const str = String(s || '');
  return str.length > maxLen ? str.slice(0, maxLen) + '\n\n[truncated]' : str;
}

function buildSystemPrompt(moduleLabel) {
  return SYSTEM_PROMPT.replace('{{MODULE_LABEL}}', moduleLabel || 'unknown');
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

  return 'Discovery session details and transcript follow as JSON:\n\n' +
    JSON.stringify(payload, null, 2);
}

async function generateAnalysis(session, moduleLabel) {
  const result = await anthropicClient.callStructured({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    systemPrompt: buildSystemPrompt(moduleLabel),
    schema: ANALYSIS_SCHEMA,
    userContent: buildUserContent(session, moduleLabel),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    effort: 'medium',
    timeoutMs: REQUEST_TIMEOUT_MS,
    schemaFileHint: 'lib/analysis.js\'s MAX_OUTPUT_TOKENS'
  });
  return { analysis: result.data, model: result.model, usage: result.usage };
}

module.exports = { generateAnalysis, ANALYSIS_SCHEMA };
