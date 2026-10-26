'use strict';

/*
 * The fixed list of session types discovery sessions are tagged against —
 * eleven specific v2 product modules, plus a general "Introduction Session"
 * for calls that orient a customer to the product as a whole rather than
 * dig into one capability. Kept as a slug (stable identifier, safe in Redis
 * keys and URLs) plus a display label (can be reworded later without
 * touching stored data). This is the single source of truth the backend
 * validates against; the frontend keeps its own small copy of the same list
 * inline, the same way it already duplicates TRANSCRIPT_MAX as a
 * client-side hint alongside server-side enforcement.
 *
 * `business-development-marketing` keeps its original id (so every existing
 * session/feature already tagged to it needs zero changes) but is now
 * narrowed to Business Development only — sequencing, opportunity
 * discovery, leads, contacts, the client/commercial-facing side. Marketing
 * (candidate marketing, campaigns, acquisition — the candidate-facing side)
 * is split out as its own module. See lib/module-classification.js's
 * MODULE_RULES for the content-classification boundary between the two, and
 * api/admin-split-marketing-module.js for the one-time migration that moved
 * existing marketing-centric cards out of the old combined module.
 */

const MODULES = [
  { id: 'introduction', label: 'Introduction Session' },
  { id: 'business-development-marketing', label: 'Business Development' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'search-match', label: 'Search & Match' },
  { id: 'conversations', label: 'Conversations' },
  { id: 'job-workflows', label: 'Job Workflows' },
  { id: 'analytics-reporting', label: 'Analytics & Reporting' },
  { id: 'portals', label: 'Portals' },
  { id: 'pay-bill', label: 'Pay & Bill' },
  { id: 'ai-automation', label: 'Agents / AI & Automation' },
  { id: 'multiposting', label: 'Multiposting' },
  { id: 'websites', label: 'Websites' }
];

const MODULE_IDS = MODULES.map(function (m) { return m.id; });

function isValidModule(id) {
  return MODULE_IDS.indexOf(id) >= 0;
}

function labelFor(id) {
  const m = MODULES.find(function (x) { return x.id === id; });
  return m ? m.label : id;
}

module.exports = { MODULES, MODULE_IDS, isValidModule, labelFor };
