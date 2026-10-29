'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');

/*
 * Read-only access to the sentiment report record. Split from
 * api/sentiment-report-build.js because that one is the slow, expensive
 * operation (an LLM call over every analyzed Product Discovery session);
 * this one is a plain Redis read and needs no special maxDuration.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  const item = await store.readSentimentReport();
  return res.status(200).json({ item: item });
};
