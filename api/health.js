const { prepareRequest } = require('../lib/http');

module.exports = async (req, res) => {
  // Public: no API key needed, so uptime checks work
  if (!prepareRequest(req, res, 'GET', { requireApiKey: false })) return;

  return res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    env_check: {
      gemini_api_key: !!process.env.GEMINI_API_KEY,
      gemini_model: process.env.GEMINI_MODEL || 'gemini-3.8-flash (default)',
      google_sheet_id: !!process.env.GOOGLE_SHEET_ID,
      google_service_account: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      gmail_configured: !!process.env.GMAIL_USER,
      api_key_required: !!process.env.API_KEY,
      allowed_origins: process.env.ALLOWED_ORIGINS ? 'restricted' : 'any'
    }
  });
};
