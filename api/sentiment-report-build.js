'use strict';

const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');
const sentimentReport = require('../lib/sentiment-report');

/*
 * (Re)builds the company-wide sentiment report from every currently-ready
 * Product Discovery session (migration-readiness sessions excluded — see
 * lib/sentiment-report.js's header). Split out from api/sentiment-report.js
 * because this is the one slow, expensive operation here — an LLM call, not
 * a Redis round trip — same reasoning as api/gtm-messaging-build.js relative
 * to api/gtm-messaging.js.
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
  const readyEntries = index.filter(function (e) {
    return e.status === 'ready' && (e.track || 'discovery') !== 'migration-readiness';
  });
  if (!readyEntries.length) {
    return res.status(400).json({ error: 'No analyzed Product Discovery sessions yet. Log and analyze at least one session first.' });
  }

  const fullRecords = await Promise.all(readyEntries.map(function (e) { return store.readSession(e.id); }));
  const sessionInputs = fullRecords
    .filter(Boolean)
    .map(function (r) {
      return {
        sessionId: r.id,
        clientName: r.customerName,
        sessionDate: r.sessionDate,
        module: r.module,
        moduleLabel: modules.labelFor(r.module),
        analysis: r.analysis
      };
    });

  const previous = await store.readSentimentReport();

  try {
    const generated = await sentimentReport.generateSentimentReport(sessionInputs);
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
    await store.writeSentimentReport(record);
    return res.status(200).json({ ok: true, item: record });
  } catch (err) {
    const reason = (err && err.message) || 'unknown error';
    console.error('sentiment report generation failed:', err && err.code, reason);
    const now = new Date().toISOString();
    /* Keep the previous result/builtFromSessionIds on a failed rebuild — a
       failed refresh must never wipe a previously-successful report. */
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
    await store.writeSentimentReport(record);

    const status = err && err.code === 'NO_API_KEY' ? 503 : 502;
    return res.status(status).json({
      error: 'Could not build the sentiment report: ' + reason + '.' +
        (previous ? ' The previous version is still available.' : ''),
      item: record
    });
  }
};
