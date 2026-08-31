'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');
const gtmMessaging = require('../lib/gtm-messaging');

/*
 * (Re)builds the overall go-to-market synthesis from every currently-ready
 * session across every module. Split out from api/gtm-messaging.js because
 * this is the one slow, expensive operation here — an LLM call, not a Redis
 * round trip — and needs its own maxDuration in vercel.json, same reasoning
 * as api/module-trends-build.js relative to api/module-trends.js.
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
      error: 'No Redis store is linked, so the result cannot be saved. Add an Upstash Redis ' +
        'integration from the Vercel Marketplace, then redeploy.',
      diagnostics: store.diagnostics()
    });
  }

  const index = await store.readSessionIndex();
  const readyEntries = index.filter(function (e) { return e.status === 'ready'; });
  if (!readyEntries.length) {
    return res.status(400).json({ error: 'No analyzed sessions yet. Log and analyze at least one session first.' });
  }

  const fullRecords = await Promise.all(readyEntries.map(function (e) { return store.readSession(e.id); }));
  const sessionInputs = fullRecords
    .filter(Boolean)
    .map(function (r) {
      /* module is the exact slug from lib/modules.js, not the display label
         — GTM_SCHEMA's module_highlights.module is an enum of those slugs,
         so the model must echo back a value it actually saw verbatim in the
         input rather than reconstruct one from a label it was given instead. */
      return {
        sessionId: r.id,
        clientName: r.customerName,
        sessionDate: r.sessionDate,
        module: r.module,
        moduleLabel: modules.labelFor(r.module),
        analysis: r.analysis
      };
    });

  const previous = await store.readGtm();

  try {
    const generated = await gtmMessaging.generateGtm(sessionInputs);
    const now = new Date().toISOString();
    const record = {
      status: 'ready',
      builtAt: now,
      builtFromSessionIds: sessionInputs.map(function (s) { return s.sessionId; }),
      sessionCountAtBuild: sessionInputs.length,
      model: generated.model,
      usage: generated.usage,
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
      result: generated.result
    };
    await store.writeGtm(record);
    return res.status(200).json({ ok: true, item: record });
  } catch (err) {
    const reason = (err && err.message) || 'unknown error';
    console.error('gtm messaging generation failed:', err && err.code, reason);
    const now = new Date().toISOString();
    /* Keep the previous result/builtFromSessionIds on a failed rebuild — a
       failed refresh must never wipe a previously-successful synthesis. */
    const record = Object.assign({}, previous, {
      status: 'error',
      lastError: reason,
      lastErrorCode: (err && err.code) || null,
      lastErrorAt: now,
      result: previous ? previous.result : null,
      builtFromSessionIds: previous ? previous.builtFromSessionIds : [],
      builtAt: previous ? previous.builtAt : null,
      sessionCountAtBuild: previous ? previous.sessionCountAtBuild : 0
    });
    await store.writeGtm(record);

    const status = err && err.code === 'NO_API_KEY' ? 503 : 502;
    return res.status(status).json({
      error: 'Could not build go-to-market messaging: ' + reason + '.' +
        (previous ? ' The previous version is still available.' : ''),
      item: record
    });
  }
};
