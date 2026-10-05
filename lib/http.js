const crypto = require('crypto');

// Shared request handling for every endpoint: CORS, method check and optional API key.
//
// ALLOWED_ORIGINS: comma-separated list of origins allowed to call the API from a
//   browser (e.g. https://your-app.lovable.app). Unset means any origin ('*').
// API_KEY: when set, every request (except the health check) must send it in the
//   x-api-key header. Don't put this key in browser code where anyone can read it;
//   call the API from a server-side function (e.g. a Supabase edge function) instead.

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function apiKeyMatches(provided) {
  const expected = Buffer.from(process.env.API_KEY);
  const actual = Buffer.from(String(provided || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Returns true when the handler should continue; false when a response was already sent
function prepareRequest(req, res, method, { requireApiKey = true } = {}) {
  const origins = allowedOrigins();
  const origin = req.headers.origin;

  if (origins.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (origins.length > 0) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', `${method}, OPTIONS`);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return false;
  }

  if (origins.length > 0 && origin && !origins.includes(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return false;
  }

  if (req.method !== method) {
    res.status(405).json({ error: 'Method not allowed' });
    return false;
  }

  if (requireApiKey && process.env.API_KEY && !apiKeyMatches(req.headers['x-api-key'])) {
    res.status(401).json({ error: 'Missing or invalid API key' });
    return false;
  }

  return true;
}

module.exports = { prepareRequest };
