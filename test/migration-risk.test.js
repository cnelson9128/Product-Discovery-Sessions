'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const migrationRisk = require('../lib/migration-risk');

function collectArrays(schema, found) {
  found = found || [];
  if (!schema || typeof schema !== 'object') return found;
  if (schema.type === 'array') found.push(schema);
  Object.values(schema.properties || {}).forEach(function (v) { collectArrays(v, found); });
  if (schema.items) collectArrays(schema.items, found);
  return found;
}

test('MIGRATION_RISK_SCHEMA never uses minItems/maxItems on an array (unsupported by Anthropic structured output)', function () {
  const arrays = collectArrays(migrationRisk.MIGRATION_RISK_SCHEMA);
  assert.ok(arrays.length > 0, 'sanity: the schema does have array fields');
  arrays.forEach(function (a) {
    assert.equal(a.minItems, undefined);
    assert.equal(a.maxItems, undefined);
  });
});

test('enum sets match the documented set of themes/severities/verdicts', function () {
  assert.deepEqual(migrationRisk.RISK_THEMES, ['technical_integration', 'data_migration', 'training_change_management', 'timeline', 'commercial_contractual', 'other']);
  assert.deepEqual(migrationRisk.SEVERITIES, ['low', 'medium', 'high']);
  assert.deepEqual(migrationRisk.READINESS_VERDICTS, ['ready', 'minor_concerns', 'major_concerns', 'not_ready']);
  assert.deepEqual(migrationRisk.DATE_VERDICTS, ['on_track', 'at_risk', 'not_discussed']);
});

test('schema properties reference those exact enum sets, not a copy that could drift', function () {
  const schema = migrationRisk.MIGRATION_RISK_SCHEMA;
  assert.deepEqual(schema.properties.overall_readiness.properties.verdict.enum, migrationRisk.READINESS_VERDICTS);
  assert.deepEqual(schema.properties.risk_areas.items.properties.theme.enum, migrationRisk.RISK_THEMES);
  assert.deepEqual(schema.properties.risk_areas.items.properties.severity.enum, migrationRisk.SEVERITIES);
  assert.deepEqual(schema.properties.target_date_feasibility.properties.verdict.enum, migrationRisk.DATE_VERDICTS);
});
