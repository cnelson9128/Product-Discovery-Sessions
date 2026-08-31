'use strict';

const store = require('../lib/store');

/* No auth in this app — see README's "Access" section. This is a cheap probe
   the page calls on load purely to know whether Redis is linked yet, so it
   can show the "storage not linked" banner instead of letting writes fail
   silently. */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  return res.status(200).json({ storage: store.configured() });
};
