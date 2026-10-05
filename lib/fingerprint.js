const crypto = require('crypto');

// Same resume text (ignoring case and spacing) means the same resume, whatever the filename
function fingerprint(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || '').toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');
}

module.exports = { fingerprint };
