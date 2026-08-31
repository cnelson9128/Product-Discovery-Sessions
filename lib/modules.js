'use strict';

/*
 * The fixed list of product modules discovery sessions are tagged against.
 * Kept as a slug (stable identifier, safe in Redis keys and URLs) plus a
 * display label (can be reworded later without touching stored data). This
 * is the single source of truth the backend validates against; the frontend
 * keeps its own small copy of the same list inline, the same way it already
 * duplicates TRANSCRIPT_MAX as a client-side hint alongside server-side
 * enforcement.
 */

const MODULES = [
  { id: 'business-development-marketing', label: 'Business Development & Marketing' },
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
