'use strict';

const crypto = require('crypto');
const auth = require('../lib/auth');
const store = require('../lib/store');
const modules = require('../lib/modules');

const NAME_MAX = 200;
const PARTICIPANTS_MAX = 500;
const TRANSCRIPT_MAX = 150000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/*
 * Any signed-in session can read and write here — there is only one shared
 * password, and everyone who has it needs full access to log and review
 * discovery sessions. Only the field allow-list below is ever written.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed.' });
};

function queryId(req) {
  /* Vercel's Node runtime populates req.query, but parse req.url directly
     too as a fallback — cheap, and removes any dependency on that runtime
     detail holding true. */
  if (req.query && req.query.id) return req.query.id;
  try {
    return new URL(req.url, 'http://x').searchParams.get('id');
  } catch (e) {
    return null;
  }
}

async function handleGet(req, res) {
  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  const id = queryId(req);
  if (id) {
    const item = await store.readSession(String(id));
    if (!item) return res.status(404).json({ error: 'No session with that id.' });
    return res.status(200).json({ item: item });
  }

  const items = await store.readSessionIndex();
  /* newest call first */
  items.sort(function (a, b) { return (b.sessionDate || '').localeCompare(a.sessionDate || '') || (b.createdAt || '').localeCompare(a.createdAt || ''); });
  return res.status(200).json({ items: items });
}

async function validateFields(body) {
  const errors = [];
  const out = {};

  const interviewer = body.interviewer;
  if (typeof interviewer !== 'string' || !interviewer.trim()) errors.push('interviewer is required.');
  else if (interviewer.length > NAME_MAX) errors.push('interviewer is longer than ' + NAME_MAX + ' characters.');
  else out.interviewer = interviewer.trim();

  const clients = await store.readClients();
  if (typeof body.customerName !== 'string' || !body.customerName.trim()) {
    errors.push('customerName is required.');
  } else if (!clients.some(function (c) { return c === body.customerName; })) {
    errors.push('customerName must be one of the managed clients — add it via the client list first.');
  } else {
    out.customerName = body.customerName;
  }

  if (typeof body.module !== 'string' || !modules.isValidModule(body.module)) {
    errors.push('module must be one of the known modules.');
  } else {
    out.module = body.module;
  }

  if (typeof body.sessionDate !== 'string' || !DATE_RE.test(body.sessionDate)) {
    errors.push('sessionDate is required and must be in YYYY-MM-DD format.');
  } else {
    out.sessionDate = body.sessionDate;
  }

  if (body.participants !== undefined && body.participants !== null && body.participants !== '') {
    if (typeof body.participants !== 'string') {
      errors.push('participants must be text.');
    } else if (body.participants.length > PARTICIPANTS_MAX) {
      errors.push('participants is longer than ' + PARTICIPANTS_MAX + ' characters.');
    } else {
      out.participants = body.participants.trim();
    }
  } else {
    out.participants = '';
  }

  return { out: out, errors: errors };
}

function validateTranscript(body) {
  if (typeof body.transcript !== 'string' || !body.transcript.trim()) {
    return { errors: ['transcript is required.'] };
  }
  if (body.transcript.length > TRANSCRIPT_MAX) {
    return { errors: ['transcript is ' + body.transcript.length + ' characters, over the ' + TRANSCRIPT_MAX + '-character limit. Trim it and try again.'] };
  }
  return { transcript: body.transcript };
}

function indexEntry(record) {
  return {
    id: record.id,
    customerName: record.customerName,
    interviewer: record.interviewer,
    sessionDate: record.sessionDate,
    module: record.module,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

async function handlePost(req, res) {
  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  if (!store.configured()) {
    return res.status(503).json({
      error: 'No Redis store is linked, so sessions cannot be saved. Add an Upstash Redis ' +
        'integration from the Vercel Marketplace, then redeploy.',
      diagnostics: store.diagnostics()
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  if (body.action === 'delete') {
    if (typeof body.id !== 'string') return res.status(400).json({ error: 'id is required.' });
    await store.deleteSession(body.id);
    return res.status(200).json({ ok: true, id: body.id, deleted: true });
  }

  if (body.action === 'update') {
    if (typeof body.id !== 'string') return res.status(400).json({ error: 'id is required.' });
    const existing = await store.readSession(body.id);
    if (!existing) return res.status(404).json({ error: 'No session with that id.' });

    const fields = await validateFields(body);
    if (fields.errors.length) return res.status(400).json({ error: fields.errors.join(' ') });

    const now = new Date().toISOString();
    const updated = Object.assign({}, existing, fields.out, { updatedAt: now });
    await store.writeSession(body.id, updated);

    const index = await store.readSessionIndex();
    const nextIndex = index.map(function (e) { return e.id === body.id ? indexEntry(updated) : e; });
    await store.writeSessionIndex(nextIndex);

    return res.status(200).json({ ok: true, item: updated });
  }

  if (body.action === 'create' || !body.action) {
    const fields = await validateFields(body);
    const transcript = validateTranscript(body);
    const errors = fields.errors.concat(transcript.errors || []);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });

    const now = new Date().toISOString();
    const record = Object.assign({}, fields.out, {
      id: crypto.randomUUID(),
      transcript: transcript.transcript,
      analysis: null,
      analysisModel: null,
      analysisGeneratedAt: null,
      status: 'draft',
      lastError: null,
      lastErrorCode: null,
      lastErrorAt: null,
      createdAt: now,
      updatedAt: now
    });

    await store.writeSession(record.id, record);
    const index = await store.readSessionIndex();
    index.push(indexEntry(record));
    await store.writeSessionIndex(index);

    return res.status(200).json({ ok: true, item: record });
  }

  return res.status(400).json({ error: 'Unknown action.' });
}
