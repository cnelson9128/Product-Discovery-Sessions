'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');

/* Cheap "am I signed in?" probe the page calls on load, so the shell can
   decide between the sign-in screen and the app without pulling any session
   data. */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let session = null;
  try {
    session = auth.sessionFrom(req);
  } catch (err) {
    /* A missing SESSION_SECRET makes every token unverifiable. Report it as
       signed-out rather than 500, so the sign-in screen still renders and the
       real problem surfaces on the login attempt. */
    console.error('session check failed:', err && err.message);
  }

  if (!session) return res.status(200).json({ signedIn: false });

  return res.status(200).json({
    signedIn: true,
    expiresAt: session.exp,
    /* The UI needs to know whether saving will actually persist before it
       offers controls that would otherwise silently fail. */
    storage: store.configured()
  });
};
