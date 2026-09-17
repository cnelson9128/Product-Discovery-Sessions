'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');

/*
 * Cross-module read path for "wow" quotes. value_moments lives inside each
 * module's pds:trend:<moduleId>.result, which api/module-trends.js's
 * unfiltered summary deliberately strips to stay light for the Modules
 * overview page — the Quote Wall needs exactly the opposite slice (every
 * module's quotes, nothing else), so it gets its own endpoint rather than
 * reusing either existing trend read path.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  const trends = await Promise.all(modules.MODULE_IDS.map(function (id) { return store.readModuleTrend(id); }));
  const items = modules.MODULE_IDS.map(function (id, i) {
    const trend = trends[i];
    return {
      module: id,
      builtAt: trend ? trend.builtAt : null,
      quotes: (trend && trend.result && trend.result.value_moments) || []
    };
  });

  return res.status(200).json({ items: items });
};
