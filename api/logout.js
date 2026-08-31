'use strict';

const auth = require('../lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  /* Unconditional: signing out must work even with an expired or malformed
     cookie, which is exactly when someone most wants to clear it. */
  res.setHeader('Set-Cookie', auth.clearedCookie());
  return res.status(200).json({ ok: true });
};
