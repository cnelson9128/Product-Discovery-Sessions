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

test('MAX_HEADLINE_STATEMENTS caps headline statements at 12', function () {
  assert.equal(sentimentReport.MAX_HEADLINE_STATEMENTS, 12);
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

test('findForbiddenTermInResult scans overall_highlights, headline_statements, and module_breakdown highlights', function () {
  const clean = {
    overall_highlights: ['Customers are excited about search speed.'],
    headline_statements: [{ quote: 'This saves us hours.' }],
    module_breakdown: [{ highlights: ['Strong, consistent positive feedback.'] }]
  };
  assert.equal(sentimentReport.findForbiddenTermInResult(clean), null);

  const highlightHit = Object.assign({}, clean, { overall_highlights: ['Customers love the Deep Search tool.'] });
  assert.deepEqual(sentimentReport.findForbiddenTermInResult(highlightHit), { field: 'overall_highlights', term: 'deep search' });

  const quoteHit = Object.assign({}, clean, { headline_statements: [{ quote: 'Deep search changed everything.' }] });
  assert.deepEqual(sentimentReport.findForbiddenTermInResult(quoteHit), { field: 'headline_statements', term: 'deep search' });

  const moduleHit = Object.assign({}, clean, { module_breakdown: [{ highlights: ['They mentioned deep search positively.'] }] });
  assert.deepEqual(sentimentReport.findForbiddenTermInResult(moduleHit), { field: 'module_breakdown', term: 'deep search' });
});

test('headline_statements no longer carries a theme field — quote only, plus attribution', function () {
  const schema = sentimentReport.SENTIMENT_SCHEMA;
  assert.deepEqual(Object.keys(schema.properties.headline_statements.items.properties).sort(), ['quote', 'supporting_session_ids']);
  assert.deepEqual(schema.properties.headline_statements.items.required.sort(), ['quote', 'supporting_session_ids']);
});

test('module_breakdown uses highlights (bullet points), not a single summary string', function () {
  const schema = sentimentReport.SENTIMENT_SCHEMA;
  const props = schema.properties.module_breakdown.items.properties;
  assert.equal(props.summary, undefined, 'summary field removed');
  assert.equal(props.highlights.type, 'array');
  assert.equal(props.highlights.items.type, 'string');
});

test('overall_highlights replaces overall_narrative as a list of bullet points', function () {
  const schema = sentimentReport.SENTIMENT_SCHEMA;
  assert.equal(schema.properties.overall_narrative, undefined);
  assert.equal(schema.properties.overall_highlights.type, 'array');
  assert.equal(schema.properties.overall_highlights.items.type, 'string');
  assert.ok(schema.required.includes('overall_highlights'));
});
