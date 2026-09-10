'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');
const trendCards = require('../lib/trend-cards');

/*
 * Moves a card to a different bucket, or marks it complete/incomplete. Split
 * from api/module-trends-build.js because this is a plain Redis
 * read-modify-write on an already-built trend — no LLM call, no special
 * maxDuration — while a build is the expensive operation that produces the
 * cards this endpoint only ever rearranges.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  if (!store.configured()) {
    return res.status(503).json({
      error: 'No Redis store is linked, so this cannot be saved. Add an Upstash Redis ' +
        'integration from the Vercel Marketplace, then redeploy.',
      diagnostics: store.diagnostics()
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const moduleId = body.module;
  if (typeof moduleId !== 'string' || !modules.isValidModule(moduleId)) {
    return res.status(400).json({ error: 'module is required and must be one of the known modules.' });
  }
  if (typeof body.cardId !== 'string') {
    return res.status(400).json({ error: 'cardId is required.' });
  }

  const trend = await store.readModuleTrend(moduleId);
  if (!trend || !trend.result || !Array.isArray(trend.result.cards)) {
    return res.status(404).json({ error: 'No trend with cards found for this module — build it first.' });
  }

  const card = trend.result.cards.find(function (c) { return c.id === body.cardId; });
  if (!card) return res.status(404).json({ error: 'No card with that id in this module\'s trend.' });

  if (body.action === 'move') {
    if (typeof body.bucket !== 'string' || !trendCards.isValidBucket(body.bucket)) {
      return res.status(400).json({ error: 'bucket must be one of: ' + trendCards.BUCKETS.join(', ') });
    }
    card.bucket = body.bucket;
  } else if (body.action === 'complete') {
    card.complete = true;
  } else if (body.action === 'reopen') {
    card.complete = false;
  } else {
    return res.status(400).json({ error: 'Unknown action.' });
  }

  trend.counts = trendCards.boardCounts(trend.result.cards);
  await store.writeModuleTrend(moduleId, trend);
  return res.status(200).json({ ok: true, item: trend });
};
