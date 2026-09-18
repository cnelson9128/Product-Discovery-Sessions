'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const modules = require('../lib/modules');
const moduleClassification = require('../lib/module-classification');

test('CLASSIFIABLE_MODULE_IDS excludes the introduction pseudo-module', function () {
  assert.ok(!moduleClassification.CLASSIFIABLE_MODULE_IDS.includes('introduction'));
});

test('CLASSIFIABLE_MODULE_IDS covers every real product module exactly once', function () {
  const expected = modules.MODULE_IDS.filter(function (id) { return id !== 'introduction'; });
  assert.deepEqual(moduleClassification.CLASSIFIABLE_MODULE_IDS.slice().sort(), expected.slice().sort());
  assert.equal(new Set(moduleClassification.CLASSIFIABLE_MODULE_IDS).size, moduleClassification.CLASSIFIABLE_MODULE_IDS.length);
});

test('CLASSIFICATION_FIELDS enums are restricted to the classifiable module set', function () {
  const fields = moduleClassification.CLASSIFICATION_FIELDS;
  assert.deepEqual(fields.primary_module.enum, moduleClassification.CLASSIFIABLE_MODULE_IDS);
  assert.deepEqual(fields.secondary_modules.items.enum, moduleClassification.CLASSIFIABLE_MODULE_IDS);
  assert.deepEqual(fields.confidence.enum, ['high', 'medium', 'low']);
});

test('CLASSIFICATION_FIELDS never uses minItems/maxItems on an array (unsupported by Anthropic structured output)', function () {
  const secondaryModules = moduleClassification.CLASSIFICATION_FIELDS.secondary_modules;
  assert.equal(secondaryModules.minItems, undefined);
  assert.equal(secondaryModules.maxItems, undefined);
});

test('buildClassificationRulesText covers every classifiable module and the key boundary scenarios from the spec', function () {
  const text = moduleClassification.buildClassificationRulesText();
  moduleClassification.CLASSIFIABLE_MODULE_IDS.forEach(function (id) {
    assert.ok(text.includes(modules.labelFor(id)), 'missing definition text for ' + id);
  });
  // Module-boundary examples straight from the spec — the two modules each
  // scenario needs to disambiguate must both actually appear in the rules
  // text, or the model has nothing to disambiguate against.
  assert.ok(text.includes('job-workflows') && text.includes('pay-bill'), 'timesheet/placement boundary present');
  assert.ok(text.includes('search-match') && text.includes('business-development-marketing'), 'candidate vs. lead enrichment boundary present');
  assert.ok(text.includes('ai-automation'), 'AI-as-primary-vs-secondary rule present');
  assert.ok(text.includes('analytics-reporting'), 'reporting-about-another-module rule present');
});
