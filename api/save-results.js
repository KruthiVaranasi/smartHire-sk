const { prepareRequest } = require('../lib/http');
const { createResultsTab, sheetsConfigured } = require('../lib/sheets-client');
const { sendResultsEmail } = require('../lib/email-sender');

const MAX_RESULTS = 500;

// Strengths / gaps as one cell of bullet lines
const bullets = (list) => (Array.isArray(list) ? list : []).map(item => `• ${item}`).join('\n');

// Saves a finished screening as a new tab in the Google Sheet (when configured) and
// emails HR a summary (when Gmail is configured). Resume text is never saved.
module.exports = async (req, res) => {
  // CORS, method check and sign-in (see lib/http.js)
  if (!prepareRequest(req, res, 'POST')) return;

  try {
    const { role, jd, answers, results } = req.body || {};

    if (!role || typeof role !== 'string') {
      return res.status(400).json({ error: 'Role is required' });
    }
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: 'results is required: the ranked candidates to save' });
    }
    if (results.length > MAX_RESULTS) {
      return res.status(400).json({ error: `Too many results (max ${MAX_RESULTS})` });
    }

    const emailConfigured = Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
    if (!sheetsConfigured() && !emailConfigured) {
      return res.status(400).json({ error: 'Neither Google Sheets nor email is configured on the server' });
    }

    // Ranked by score, ties by name, so the saved order matches what HR saw
    const ranked = results
      .map(r => ({ ...r, score: Number(r.score) || 0 }))
      .sort((a, b) => b.score - a.score || String(a.candidate_name).localeCompare(String(b.candidate_name)))
      .map((r, i) => ({ ...r, rank: i + 1 }));

    let saved = null;
    if (sheetsConfigured()) {
      const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const qa = Array.isArray(answers) ? answers : [];
      const values = [
        ['Role', role],
        ['Screened', `${when} UTC`],
        ['Candidates', String(ranked.length)],
        ['Job description', String(jd || '')],
        ...qa.map((item, i) => [`Q${i + 1}: ${item.question || ''}`, String(item.answer || '')]),
        [],
        ['Rank', 'Candidate', 'File', 'Score', 'Recommendation', 'Interview priority', 'Strengths', 'Gaps', 'Justification'],
        ...ranked.map(r => [
          r.rank,
          String(r.candidate_name || ''),
          String(r.filename || ''),
          r.score,
          String(r.recommendation || ''),
          String(r.interview_priority || ''),
          bullets(r.strengths),
          bullets(r.gaps),
          String(r.justification || '')
        ])
      ];
      saved = await createResultsTab(`${role} · ${when.replace(":", ".")}`, values);
      console.log(`Saved ${ranked.length} results to tab "${saved.title}"`);
    }

    const emailSent = emailConfigured ? await sendResultsEmail(ranked, role, saved && saved.url) : false;

    return res.status(200).json({
      success: true,
      message: saved ? `Saved to Google Sheets tab "${saved.title}"` : 'Summary emailed',
      data: {
        saved_to_sheet: Boolean(saved),
        sheet_url: saved ? saved.url : null,
        tab: saved ? saved.title : null,
        email_sent: emailSent
      }
    });

  } catch (error) {
    console.error('Save results error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
