'use strict';

/*
 * The fixed list of migration-readiness batches — the migration-track
 * equivalent of lib/modules.js's MODULES. Two customers per batch run
 * migration-readiness sessions to establish that batch's real-world
 * readiness to move; the batch definitions themselves are permanent program
 * structure, so they're hardcoded here exactly like the 11 modules, while
 * each batch's actual client roster and target date are Redis-backed and
 * editable (see lib/store.js's readMigrationRoster/writeMigrationRoster).
 */

const BATCHES = [
  { id: 'batch-1', label: 'Batch 1', description: 'Perm workflow only, Gmail and Microsoft365 integrations only' },
  { id: 'batch-2', label: 'Batch 2', description: 'Perm, Contract + Temp workflows, no integrations' },
  { id: 'batch-3', label: 'Batch 3', description: 'Core job board use: Indeed, Reed, Total Jobs, CV Library + standard jobs page' },
  { id: 'batch-4', label: 'Batch 4', description: 'Candidate portal + blended jobs page (custom CSS header and footer)' },
  { id: 'batch-5', label: 'Batch 5', description: 'Employer portal' },
  { id: 'batch-6', label: 'Batch 6', description: 'Niche job boards' },
  { id: 'batch-7', label: 'Batch 7', description: 'Full website offering + full public API, integrations such as BD, marketing, analytics, VOIP' },
  { id: 'batch-8', label: 'Batch 8', description: 'Custom APIs, complex setups in Firefish' }
];

const BATCH_IDS = BATCHES.map(function (b) { return b.id; });

function isValidBatch(id) {
  return BATCH_IDS.indexOf(id) >= 0;
}

function labelFor(id) {
  const b = BATCHES.find(function (x) { return x.id === id; });
  return b ? b.label : id;
}

function descriptionFor(id) {
  const b = BATCHES.find(function (x) { return x.id === id; });
  return b ? b.description : '';
}

module.exports = { BATCHES, BATCH_IDS, isValidBatch, labelFor, descriptionFor };
