'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const modules = require('../lib/modules');
const sentimentReport = require('../lib/sentiment-report');

function collectArrays(schema, found) {
  found = found || [];
  if (!schema || typeof schema !== 'object') return found;
  if (schema.type === 'array') found.push(schema);
  Object.values(schema.properties || {}).forEach(function (v) { collectArrays(v, found); });
  if (schema.items) collectArrays(schema.items, found);
  return found;
}

test('SENTIMENT_SCHEMA never uses minItems/maxItems on an array (unsupported by Anthropic structured output)', function () {
  const arrays = collectArrays(sentimentReport.SENTIMENT_SCHEMA);
  assert.ok(arrays.length > 0, 'sanity: the schema does have array fields');
  arrays.forEach(function (a) {
    assert.equal(a.minItems, undefined);
    assert.equal(a.maxItems, undefined);
  });
});

test('overall_sentiment and module sentiment enums are distinct (module allows not_enough_signal, overall does not)', function () {
  assert.deepEqual(sentimentReport.SENTIMENT_LEVELS, ['strongly_positive', 'positive', 'mixed', 'needs_attention']);
  assert.deepEqual(
    sentimentReport.MODULE_SENTIMENT_LEVELS,
    sentimentReport.SENTIMENT_LEVELS.concat(['not_enough_signal'])
  );
  const schema = sentimentReport.SENTIMENT_SCHEMA;
  assert.deepEqual(schema.properties.overall_sentiment.enum, sentimentReport.SENTIMENT_LEVELS);
  assert.deepEqual(schema.properties.module_breakdown.items.properties.sentiment.enum, sentimentReport.MODULE_SENTIMENT_LEVELS);
});

test('module_breakdown.module is restricted to the known module ids, kept in sync with lib/modules.js', function () {
  const schema = sentimentReport.SENTIMENT_SCHEMA;
  assert.deepEqual(schema.properties.module_breakdown.items.properties.module.enum, modules.MODULE_IDS);
});

test('headline_statements and module_breakdown both require supporting_session_ids', function () {
  const schema = sentimentReport.SENTIMENT_SCHEMA;
  assert.ok(schema.properties.headline_statements.items.required.includes('supporting_session_ids'));
  assert.ok(schema.properties.module_breakdown.items.required.includes('supporting_session_ids'));
});

test('isExcludedClient matches case-insensitively and as a substring, since the exact stored spelling may vary', function () {
  assert.equal(sentimentReport.isExcludedClient('Carmichael'), true);
  assert.equal(sentimentReport.isExcludedClient('carmichael recruitment ltd'), true);
  assert.equal(sentimentReport.isExcludedClient('CARMICHAEL'), true);
  assert.equal(sentimentReport.isExcludedClient('Acme Recruiting'), false);
  assert.equal(sentimentReport.isExcludedClient(''), false);
  assert.equal(sentimentReport.isExcludedClient(undefined), false);
});

test('containsForbiddenTerm matches case-insensitively', function () {
  assert.equal(sentimentReport.containsForbiddenTerm('We love the Deep Search feature'), 'deep search');
  assert.equal(sentimentReport.containsForbiddenTerm('deep search is great'), 'deep search');
  assert.equal(sentimentReport.containsForbiddenTerm('nothing forbidden here'), null);
});

test('findForbiddenTermInResult scans overall_narrative, headline_statements, and module_breakdown summaries', function () {
  const clean = {
    overall_narrative: 'Customers are excited about search speed.',
    headline_statements: [{ quote: 'This saves us hours.', theme: 'Time savings' }],
    module_breakdown: [{ summary: 'Strong, consistent positive feedback.' }]
  };
  assert.equal(sentimentReport.findForbiddenTermInResult(clean), null);

  const narrativeHit = Object.assign({}, clean, { overall_narrative: 'Customers love the Deep Search tool.' });
  assert.deepEqual(sentimentReport.findForbiddenTermInResult(narrativeHit), { field: 'overall_narrative', term: 'deep search' });

  const quoteHit = Object.assign({}, clean, { headline_statements: [{ quote: 'Deep search changed everything.', theme: 'x' }] });
  assert.deepEqual(sentimentReport.findForbiddenTermInResult(quoteHit), { field: 'headline_statements', term: 'deep search' });

  const summaryHit = Object.assign({}, clean, { module_breakdown: [{ summary: 'They mentioned deep search positively.' }] });
  assert.deepEqual(sentimentReport.findForbiddenTermInResult(summaryHit), { field: 'module_breakdown', term: 'deep search' });
});
