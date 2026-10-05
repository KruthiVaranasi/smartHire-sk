const crypto = require('crypto');

// Shared request handling for every endpoint: CORS, method check and access control.
//
// ALLOWED_ORIGINS: comma-separated list of origins allowed to call the API from a
//   browser (e.g. https://your-app.lovable.app). Unset means any origin ('*').
// APP_PASSWORD: shared password for the web app. When set, requests must carry a
//   session token from POST /api/login in an "Authorization: Bearer <token>" header.
// API_KEY: when set, server-to-server callers can send it in the x-api-key header
//   instead. Don't put it in browser code, where anyone can read it.
// With neither APP_PASSWORD nor API_KEY set, the API is open.

const SESSION_HOURS = 12;

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

// Constant-time string comparison
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Tokens are signed with the password itself, so changing APP_PASSWORD signs everyone out
function sign(payload) {
  return crypto.createHmac('sha256', process.env.APP_PASSWORD).update(payload).digest('base64url');
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600 * 1000 })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expiresInSeconds: SESSION_HOURS * 3600 };
}

function sessionValid(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch (error) {
    return false;
  }
}

function passwordMatches(password) {
  return safeEqual(password, process.env.APP_PASSWORD);
}

function isAuthorized(req) {
  const { APP_PASSWORD, API_KEY } = process.env;
  if (!APP_PASSWORD && !API_KEY) return true;
  if (API_KEY && safeEqual(req.headers['x-api-key'], API_KEY)) return true;
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(APP_PASSWORD && bearer && sessionValid(bearer));
}

// Returns true when the handler should continue; false when a response was already sent
// The web app in public/ calls the API from the same site; browsers still send an
// Origin header on its POSTs, so that origin is always allowed
function isSameOrigin(req, origin) {
  try {
    return new URL(origin).host === req.headers.host;
  } catch (error) {
    return false;
  }
}

function prepareRequest(req, res, method, { requireAuth = true } = {}) {
  const origin = req.headers.origin;
  const origins = allowedOrigins();
  const restricted = origins.length > 0;   // no ALLOWED_ORIGINS means any origin
  const originAllowed = !origin || !restricted || origins.includes(origin) || isSameOrigin(req, origin);

  if (!restricted) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    if (origin && originAllowed) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', `${method}, OPTIONS`);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return false;
  }

  if (!originAllowed) {
    res.status(403).json({ error: 'Origin not allowed' });
    return false;
  }

  if (req.method !== method) {
    res.status(405).json({ error: 'Method not allowed' });
    return false;
  }

  if (requireAuth && !isAuthorized(req)) {
    res.status(401).json({ error: 'Sign in required', auth: process.env.APP_PASSWORD ? 'password' : 'api_key' });
    return false;
  }

  return true;
}

module.exports = { prepareRequest, createSessionToken, passwordMatches };
