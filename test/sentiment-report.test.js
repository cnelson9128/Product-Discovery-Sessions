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
