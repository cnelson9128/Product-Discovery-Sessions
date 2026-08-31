'use strict';

/*
 * Session handling for the product-discovery-sessions artifact.
 *
 * One shared password, supplied as a Vercel environment variable, for a small
 * trusted team — there is no viewer/admin split like the sibling
 * competitor-analysis app, since everyone who has the password can log
 * sessions, read every session, and regenerate analysis. A successful login
 * mints an HMAC-signed token carrying only {iat, exp} — no role, since there
 * is nothing to branch on — and nothing secret, set as an HttpOnly cookie.
 * Nothing about the session is stored server-side, so there is no session
 * store to provision or expire.
 *
 * This file must never be reachable over HTTP. It lives outside `public/`,
 * which vercel.json pins as the static root.
 */

const crypto = require('crypto');

const COOKIE = 'pds_session';
const TTL_HOURS = clampTtl(process.env.SESSION_TTL_HOURS);

function clampTtl(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 12;
  return Math.min(n, 24 * 7);
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

/* Configuration problems must fail loudly at request time rather than
   degrading into an artifact that lets everybody in. */
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET is missing or shorter than 32 characters');
  }
  return s;
}

function appPassword() {
  const p = process.env.APP_PASSWORD;
  if (!p) {
    throw new Error('APP_PASSWORD must be set');
  }
  return p;
}

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', secret()).update(payloadB64).digest());
}

/* Compare through a digest so the comparison is always over a fixed 32 bytes.
   Comparing the raw strings would leak their length through the timing. */
function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function issue() {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ iat: now, exp: now + TTL_HOURS * 3600 }));
  return payload + '.' + sign(payload);
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;

  const payloadB64 = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = sign(payloadB64);
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function isCorrectPassword(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  return constantTimeEqual(candidate, appPassword());
}

function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const out = {};
  header.split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch (e) {
      out[k] = part.slice(i + 1).trim();
    }
  });
  return out;
}

function sessionFrom(req) {
  return verify(parseCookies(req)[COOKIE]);
}

function cookie(token, maxAgeSeconds) {
  const bits = [
    COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + maxAgeSeconds
  ];
  /* Secure would make the cookie unusable over plain http on localhost, so it
     is set whenever we are actually running on Vercel — i.e. always in prod. */
  if (process.env.VERCEL) bits.push('Secure');
  return bits.join('; ');
}

function sessionCookie(token) {
  return cookie(token, TTL_HOURS * 3600);
}

function clearedCookie() {
  return cookie('', 0);
}

/* Returns the session, or writes the error response and returns null. Callers
   must stop as soon as this yields null. */
function requireSession(req, res) {
  const session = sessionFrom(req);
  if (!session) {
    res.status(401).json({ error: 'Not signed in.' });
    return null;
  }
  return session;
}

function clientIp(req) {
  const fwd = (req.headers && req.headers['x-forwarded-for']) || '';
  const first = String(fwd).split(',')[0].trim();
  return first || (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = {
  COOKIE,
  TTL_HOURS,
  issue,
  verify,
  isCorrectPassword,
  sessionFrom,
  sessionCookie,
  clearedCookie,
  requireSession,
  clientIp,
  constantTimeEqual
};
