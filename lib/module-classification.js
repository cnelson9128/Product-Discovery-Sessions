'use strict';

/*
 * Single source of truth for "what does each module mean," used to classify
 * a feature/problem/request/opportunity by its content and intended outcome
 * — never by which session or module tag it happened to surface under. Two
 * callers share this text and schema fragment verbatim:
 *   - lib/raised-items.js, which extracts and classifies items straight from
 *     a session's transcript at analysis time.
 *   - classifyExistingItems() below, a standalone classifier over already-
 *     written {item, rationale} text with no transcript access — used to
 *     reclassify legacy cards that predate per-item classification
 *     (api/admin-reclassify-features.js) and to let a human hand a manually-
 *     overridden card back to the parser (api/features.js's
 *     'resetClassification' action, when the card has no linked session item
 *     to recompute from directly).
 *
 * "introduction" is deliberately excluded from the classifiable set: an
 * Introduction Session has no product surface of its own, so nothing raised
 * during one should ever be filed there — it must land on whichever real
 * module it's actually about, which is exactly the case the spec calls out.
 */

const modules = require('./modules');
const anthropicClient = require('./anthropic-client');

const CLASSIFIABLE_MODULE_IDS = modules.MODULE_IDS.filter(function (id) { return id !== 'introduction'; });

/* Condensed from the module definitions supplied for this feature. "Portals"
   and "Websites" aren't covered by that spec (it only defines the other
   eight modules) — their bullets below are a best-effort extrapolation from
   what those two module labels mean in this product, flagged here so it's
   easy to find and correct if the real definition differs. */
const MODULE_RULES = {
  'job-workflows': [
    'Creating and managing contract, shift, or permanent jobs.',
    'Moving candidates through workflow stages: applications, submissions, interviews, placements, assignments, bookings.',
    'Configuring job-specific processes, fields, compliance requirements, and workflow stages.',
    'Managing terms, rates, assignment information, and booking details within the recruitment workflow.',
    'Supporting different recruitment workflows within the same agency and platform.',
    'Actions taken from job boards, job lists, placement views, or booking views.'
  ],
  'search-match': [
    'Searching across candidates, contacts, companies, leads, and jobs.',
    'Building, saving, sharing, or rerunning searches.',
    'Creating and managing lists, shortlists, and talent pools.',
    'Searching using skills, experience, location, availability, preferences, and compliance data.',
    'Enriching candidate, contact, company, or lead records where the purpose is improved discovery, qualification, or matching.',
    'Ranking or matching candidates against job requirements.',
    'Tagging, grouping, filtering, sorting, or managing search results; configuring columns, fields, and bulk actions in result lists.'
  ],
  conversations: [
    'Capturing communication or activity against a record: emails, notes, calls, messages, meetings, tasks, reminders, follow-ups.',
    'Creating reusable communication and activity templates.',
    'Using activities to trigger workflows, automations, tasks, or sequences.',
    'Scheduling and managing future actions.',
    'Visibility of relationships, communication history, and activity across users and teams.',
    'Shared timelines, activity feeds, notifications, and ownership of actions.'
  ],
  'business-development-marketing': [
    'Creating and managing leads, lead suggestions, contacts, and companies for commercial development.',
    'Using enrichment across leads, contacts, and companies to improve targeting and qualification.',
    'Managing opportunities through lead pipelines, Kanban boards, and list views (sales, project, partnership, or other configurable pipelines).',
    'Forecasting potential revenue and monitoring business-development activity.',
    'Creating email- and task-based prospecting sequences; managing outreach, qualification, follow-up, conversion.',
    'Converting qualified leads into jobs or recruitment workflows.'
  ],
  'analytics-reporting': [
    'Creating reports, dashboards, visualisations, and KPIs.',
    'Cross-module and cross-workflow reporting, including across contract, shift, and permanent recruitment.',
    'Monitoring recruiter activity, jobs, candidates, placements, assignments, bookings, revenue, conversion, performance.',
    'Building reports for different users, teams, offices, brands, divisions.',
    'Filtering, exporting, scheduling, or sharing reports.',
    'Turning live platform data into actionable insights; identifying trends, exceptions, risks, opportunities.'
  ],
  multiposting: [
    'Creating adverts from job information.',
    'Publishing jobs and adverts across websites, job boards, and other channels.',
    'Managing advert creation, approval, publishing, expiry, refresh workflows.',
    'Receiving and managing advert responses and applications; tracking application sources and channel performance.',
    'Moving applicants into the main database, Search & Match, and Job Workflows.',
    'Managing multiposting integrations and advertising channels.'
  ],
  'ai-automation': [
    'Using AI to parse CVs, job specifications, and other documents.',
    'Using AI to create or populate documents and structured records.',
    'Generating or improving text, summaries, notes, messages, or other content.',
    'An AI note-taker for online meetings and structured follow-up.',
    'Agents that complete tasks or assist users across different modules.',
    'Surfacing recommended or next-best actions from records, conversations, and workflow activity.',
    'Automating repetitive tasks, communications, follow-ups, or operational processes; cross-platform automation rules, triggers, outcomes.',
    'Use this module as PRIMARY only when the AI/agent/automation capability itself is the main feature requested. When AI merely supports a specific module but the main value is the underlying recruitment function, classify under that functional module instead and list ai-automation as a secondary module.'
  ],
  'pay-bill': [
    'Configuring pay and charge rates for clients, jobs, assignments, and workers.',
    'Creating, submitting, reviewing, approving, rejecting, or correcting timesheets.',
    'Managing working time and pay-related reporting patterns.',
    'Calculating overtime, exceptions, holiday rules, rate rules, parity rules, rest rules.',
    'Connecting placements, assignments, and bookings to downstream pay and billing processes.',
    'Candidate/hiring-manager access to timesheet, approval, pay, or billing processes.',
    'Pay and bill calculations, approvals, exports, integrations, exceptions.'
  ],
  portals: [
    'Self-service portals for candidates, workers, or clients outside the main recruiter-facing platform.',
    'Candidate/worker access to their own timesheets, documents, compliance items, or assignment details via a portal.',
    'Client-facing visibility into their own jobs, candidates, or placements via a portal.',
    'Portal branding, configuration, and self-service actions performed by an external user rather than a recruiter.',
    'Not: the underlying timesheet/pay calculation itself (Pay & Bill) or the underlying job/placement data (Job Workflows) — only the portal surface that exposes it.'
  ],
  websites: [
    'The agency\'s own career site or public-facing website: content, design, publishing, SEO.',
    'Hosting or building web pages that present the agency\'s jobs or brand, as distinct from pushing job adverts out to third-party job boards or channels (that\'s Multiposting & Adverts).',
    'Website-level configuration, templates, and integrations with the agency\'s own site.'
  ]
};

const BOUNDARY_RULES = `Classification boundaries — apply these where modules could overlap:
- Recruitment stages, placements, assignments, and bookings belong to job-workflows.
- Timesheets, pay calculations, charge calculations, rate rules, and billing belong to pay-bill.
- General communication history and task management belong to conversations.
- Prospecting sequences and lead-pipeline outreach belong to business-development-marketing.
- Candidate discovery, result management, and job matching belong to search-match.
- Candidate enrichment used for matching belongs to search-match; lead/contact/company enrichment used
  for commercial targeting belongs to business-development-marketing.
- AI-enabled functionality normally stays within its functional module unless the AI/agent/automation
  capability is itself the primary product requirement — then it's ai-automation.
- Reporting about another module still belongs to analytics-reporting when the principal request is for
  a report, dashboard, metric, or insight, rather than for the underlying capability itself.
- A self-service portal surface belongs to portals even when the data it exposes belongs to another
  module (e.g. a candidate viewing their own timesheet via a portal is portals, not pay-bill).`;

function buildModuleDefinitionsText() {
  return CLASSIFIABLE_MODULE_IDS.map(function (id) {
    const bullets = MODULE_RULES[id].map(function (b) { return '  - ' + b; }).join('\n');
    return modules.labelFor(id) + ' ("' + id + '"):\n' + bullets;
  }).join('\n\n');
}

function buildClassificationRulesText() {
  return 'Module definitions:\n\n' + buildModuleDefinitionsText() + '\n\n' + BOUNDARY_RULES;
}

/* Shared JSON-schema fragment for one classified item. Deliberately no
   minItems/maxItems anywhere in either caller's schema — Anthropic's
   structured-output schemas reject that on arrays (a real, previously-hit
   400: "For 'array' type, property 'maxItems' is not supported"). */
const CLASSIFICATION_FIELDS = {
  primary_module: { type: 'string', enum: CLASSIFIABLE_MODULE_IDS },
  secondary_modules: { type: 'array', items: { type: 'string', enum: CLASSIFIABLE_MODULE_IDS } },
  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  classification_reason: { type: 'string' }
};

const RECLASSIFY_MODEL = 'claude-opus-5';
const RECLASSIFY_MAX_OUTPUT_TOKENS = 8000;
const RECLASSIFY_TIMEOUT_MS = 120000;

const RECLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: Object.assign({ key: { type: 'string' } }, CLASSIFICATION_FIELDS),
        required: ['key', 'primary_module', 'secondary_modules', 'confidence', 'classification_reason'],
        additionalProperties: false
      }
    }
  },
  required: ['classifications'],
  additionalProperties: false
};

function buildReclassifySystemPrompt() {
  return `You are classifying existing roadmap feature/problem/request cards for Firefish Software's v2
recruitment CRM into the single product module each one is really about, using only the short item
text and rationale given — there is no transcript here, so classify on the meaning of the text alone.

${buildClassificationRulesText()}

For each item given, return exactly one classification with the same "key" you were given. Pick the
ONE primary module whose definition most closely matches the content and intended outcome of the item
— never split one item across two primaries. List a secondary module only when the item is genuinely
about two modules' outcomes at once; most items have no secondary module (return an empty array). Set
"confidence" to "low" whenever the item is genuinely ambiguous or could plausibly fit more than one
module about equally well — a low-confidence call is expected to happen sometimes and is not a failure,
it flags the card for a human to glance at. "classification_reason" is one short sentence a human
reviewing the card can use to sanity-check your choice.`;
}

/* items: [{key, item, rationale}] -> [{key, primary_module, secondary_modules,
   confidence, classification_reason}], one entry per input key. Batches in
   one call — callers should chunk very large lists themselves if needed. */
async function classifyExistingItems(items) {
  if (!items.length) return [];
  const result = await anthropicClient.callStructured({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: RECLASSIFY_MODEL,
    systemPrompt: buildReclassifySystemPrompt(),
    schema: RECLASSIFY_SCHEMA,
    userContent: 'Items to classify follow as JSON:\n\n' + JSON.stringify(items, null, 2),
    maxOutputTokens: RECLASSIFY_MAX_OUTPUT_TOKENS,
    effort: 'medium',
    timeoutMs: RECLASSIFY_TIMEOUT_MS,
    schemaFileHint: 'lib/module-classification.js\'s RECLASSIFY_MAX_OUTPUT_TOKENS'
  });
  return result.data.classifications;
}

module.exports = {
  CLASSIFIABLE_MODULE_IDS,
  CLASSIFICATION_FIELDS,
  buildClassificationRulesText,
  classifyExistingItems
};
