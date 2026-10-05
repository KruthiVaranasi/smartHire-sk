const { prepareRequest, createSessionToken, passwordMatches } = require('../lib/http');

// Exchanges the shared APP_PASSWORD for a session token (see lib/http.js)
module.exports = async (req, res) => {
  if (!prepareRequest(req, res, 'POST', { requireAuth: false })) return;

  if (!process.env.APP_PASSWORD) {
    return res.status(200).json({ success: true, password_required: false, token: null });
  }

  const { password } = req.body || {};

  if (!passwordMatches(password)) {
    // Slow down guessing
    await new Promise(resolve => setTimeout(resolve, 800));
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const { token, expiresInSeconds } = createSessionToken();
  return res.status(200).json({ success: true, password_required: true, token, expires_in: expiresInSeconds });
};
