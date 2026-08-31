'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');

/*
 * Read-only access to module trend records. Split from
 * api/module-trends-build.js because that one is the slow, expensive
 * operation (an LLM call over every session in a module); this one is a
 * plain Redis read and needs no special maxDuration.
 */
function queryModule(req) {
  /* Vercel's Node runtime populates req.query, but parse req.url directly
     too as a fallback — cheap, and removes any dependency on that runtime
     detail holding true. */
  if (req.query && req.query.module) return req.query.module;
  try {
    return new URL(req.url, 'http://x').searchParams.get('module');
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  const moduleId = queryModule(req);
  if (moduleId) {
    if (!modules.isValidModule(moduleId)) return res.status(400).json({ error: 'Unknown module.' });
    const item = await store.readModuleTrend(moduleId);
    return res.status(200).json({ item: item });
  }

  const trends = await store.readAllModuleTrendSummaries(modules.MODULE_IDS);
  return res.status(200).json({ trends: trends });
};
