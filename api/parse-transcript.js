'use strict';

const mammoth = require('mammoth');
const auth = require('../lib/auth');

/*
 * Extracts plain text from an uploaded .docx transcript, so the person
 * logging the session can review/edit it in the textarea before submitting —
 * same flow as a .txt upload, which is read client-side and never touches
 * this endpoint. Only .docx needs a server round trip: it's a zipped-XML
 * format with no dependency-free way to read it in the browser.
 *
 * Takes the file as base64 in a JSON body rather than multipart/form-data —
 * this repo has no multipart parser and adding one just to avoid a ~33%
 * base64 size overhead on a text transcript isn't worth a second dependency.
 */

const MAX_BASE64_CHARS = 20_000_000; /* ~15MB decoded — generous for a transcript */

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const session = auth.requireSession(req, res);
  if (!session) return undefined;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.fileBase64 !== 'string' || !body.fileBase64) {
    return res.status(400).json({ error: 'fileBase64 is required.' });
  }
  if (body.fileBase64.length > MAX_BASE64_CHARS) {
    return res.status(400).json({ error: 'That file is too large. Paste the transcript text directly instead.' });
  }

  let buffer;
  try {
    buffer = Buffer.from(body.fileBase64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'Could not decode the uploaded file.' });
  }

  try {
    const result = await mammoth.extractRawText({ buffer: buffer });
    const text = (result.value || '').trim();
    if (!text) {
      return res.status(422).json({ error: 'No readable text found in that document. Try pasting the transcript directly.' });
    }
    return res.status(200).json({ ok: true, text: text });
  } catch (err) {
    console.error('docx parse failed:', err && err.message);
    return res.status(422).json({
      error: 'Could not read that as a Word document (' + ((err && err.message) || 'unknown error') +
        '). Try pasting the transcript directly, or saving it as .txt.'
    });
  }
};
