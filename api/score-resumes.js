const { prepareRequest } = require('../lib/http');
const { scoreResume } = require('../lib/gemini-client');

// Each call scores a small batch so it finishes well inside Vercel's 60s limit;
// the browser sends the next batch until every resume is scored.
const MAX_RESUMES_PER_CALL = 5;
const CONCURRENCY = 3;   // keeps well under Gemini's free-tier requests per minute
const MAX_ANSWERS = 10;
const MAX_JD_CHARS = 20000;
const MAX_RESUME_CHARS = 40000;

// Run fn over items with at most `limit` in flight; results in input order
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Returns an error body for a bad request, or null when it's fine
function validate({ jd, answers, resumes }) {
  if (typeof jd !== 'string' || jd.trim().length < 30) {
    return { error: 'Job description (jd) is required' };
  }
  if (jd.length > MAX_JD_CHARS) {
    return { error: `Job description is too long (max ${MAX_JD_CHARS} characters)` };
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    return { error: 'answers is required: a list of { question, answer } for the questions from /api/generate-questions' };
  }
  if (answers.length > MAX_ANSWERS) {
    return { error: `Too many answers (max ${MAX_ANSWERS})` };
  }
  const blank = answers
    .map((qa, i) => ({ i, ok: qa && String(qa.question || '').trim() && String(qa.answer || '').trim() }))
    .filter(x => !x.ok)
    .map(x => x.i + 1);
  if (blank.length > 0) {
    return { error: 'Every question needs an answer', missing_answers: blank };
  }
  if (!Array.isArray(resumes) || resumes.length === 0) {
    return { error: 'resumes is required: a list of { id, filename, resume } from /api/upload-resume' };
  }
  if (resumes.length > MAX_RESUMES_PER_CALL) {
    return { error: `Too many resumes in one call (max ${MAX_RESUMES_PER_CALL}); send them in batches` };
  }
  if (resumes.some(r => !r || typeof r.resume !== 'string' || r.resume.trim().length < 50)) {
    return { error: 'Every resume needs its extracted text in "resume"' };
  }
  return null;
}

// Scores a batch of resumes against the JD and HR's answers. Stateless: the caller
// sends everything needed and ranks the combined results itself.
module.exports = async (req, res) => {
  // CORS, method check and sign-in (see lib/http.js)
  if (!prepareRequest(req, res, 'POST')) return;

  try {
    const body = req.body || {};
    const invalid = validate(body);
    if (invalid) {
      return res.status(400).json(invalid);
    }

    const jd = body.jd.trim();
    const hrAnswers = body.answers.map(qa => ({
      question: String(qa.question).trim(),
      answer: String(qa.answer).trim()
    }));

    console.log(`Scoring ${body.resumes.length} resume(s)...`);

    const results = await mapWithLimit(body.resumes, CONCURRENCY, async (r) => {
      const base = { id: r.id || null, filename: String(r.filename || '') };
      try {
        const scoring = await scoreResume(jd, r.resume.slice(0, MAX_RESUME_CHARS), hrAnswers);
        return {
          ...base,
          candidate_name: scoring.candidate_name || '',
          score: scoring.match_score,
          score_breakdown: scoring.score_breakdown || null,
          strengths: (scoring.strengths || []).map(String),
          gaps: (scoring.gaps || []).map(String),
          justification: scoring.justification || '',
          recommendation: scoring.recommendation || '',
          interview_priority: scoring.interview_priority || ''
        };
      } catch (error) {
        console.error(`Error scoring ${base.filename}:`, error);
        return {
          ...base,
          candidate_name: '',
          score: 0,
          score_breakdown: null,
          strengths: [],
          gaps: [],
          justification: `Failed to score: ${error.message}`,
          recommendation: 'Error',
          interview_priority: '',
          error: error.message
        };
      }
    });

    return res.status(200).json({
      success: true,
      data: {
        scored: results.filter(r => r.recommendation !== 'Error').length,
        failed: results.filter(r => r.recommendation === 'Error').length,
        results
      }
    });

  } catch (error) {
    console.error('Scoring error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
