'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');

const MAX_FAILURES = 10;
const WINDOW_SECONDS = 15 * 60;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const ip = auth.clientIp(req);

  try {
    const failures = await store.countFailures(ip);
    if (failures >= MAX_FAILURES) {
      return res.status(429).json({
        error: 'Too many failed attempts. Try again in 15 minutes.'
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const password = typeof body.password === 'string' ? body.password : '';

    if (!auth.isCorrectPassword(password)) {
      await store.bumpFailures(ip, WINDOW_SECONDS);
      return res.status(401).json({ error: 'That password was not recognised.' });
    }

    await store.clearFailures(ip);
    res.setHeader('Set-Cookie', auth.sessionCookie(auth.issue()));
    return res.status(200).json({ ok: true, expiresInHours: auth.TTL_HOURS });
  } catch (err) {
    /* Missing SESSION_SECRET or APP_PASSWORD lands here. Say enough for the
       operator to fix it without handing details to an anonymous caller. */
    console.error('login failed:', err && err.message);
    return res.status(500).json({
      error: 'Sign-in is not configured correctly. Check the server environment variables.'
    });
  }
};
