'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const moonMatch = require('../lib/moon-match');

function collectArrays(schema, found) {
  found = found || [];
  if (!schema || typeof schema !== 'object') return found;
  if (schema.type === 'array') found.push(schema);
  Object.values(schema.properties || {}).forEach(function (v) { collectArrays(v, found); });
  if (schema.items) collectArrays(schema.items, found);
  return found;
}

test('MATCH_SCHEMA never uses minItems/maxItems on an array (unsupported by Anthropic structured output)', function () {
  const arrays = collectArrays(moonMatch.MATCH_SCHEMA);
  assert.ok(arrays.length > 0, 'sanity: the schema does have array fields');
  arrays.forEach(function (a) {
    assert.equal(a.minItems, undefined);
    assert.equal(a.maxItems, undefined);
  });
});

test('CONFIDENCE_LEVELS matches the schema enum exactly', function () {
  assert.deepEqual(moonMatch.CONFIDENCE_LEVELS, ['high', 'medium', 'low']);
  assert.deepEqual(moonMatch.MATCH_SCHEMA.properties.matches.items.properties.confidence.enum, moonMatch.CONFIDENCE_LEVELS);
});

test('matchCommitsToCards short-circuits to [] without any cards or any commits, making no API call', async function () {
  assert.deepEqual(await moonMatch.matchCommitsToCards([], [{ sha: 'a', message: 'm' }]), []);
  assert.deepEqual(await moonMatch.matchCommitsToCards([{ id: 'f1' }], []), []);
  assert.deepEqual(await moonMatch.matchCommitsToCards([], []), []);
});

test('every match requires feature_card_id, confidence, reason, and evidence_commit_shas', function () {
  const required = moonMatch.MATCH_SCHEMA.properties.matches.items.required;
  assert.deepEqual(required.sort(), ['confidence', 'evidence_commit_shas', 'feature_card_id', 'reason']);
});
