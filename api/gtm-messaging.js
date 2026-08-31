'use strict';

const store = require('../lib/store');

/*
 * Read-only access to the overall go-to-market record. Split from
 * api/gtm-messaging-build.js because that one is the slow, expensive
 * operation (an LLM call over every analyzed session across every module);
 * this one is a plain Redis read and needs no special maxDuration.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const item = await store.readGtm();
  return res.status(200).json({ item: item });
};
