const { prepareRequest } = require('../lib/http');
const { readSheet, updateRows } = require('../lib/sheets-client');
const { scoreResume } = require('../lib/gemini-client');
const { sendResultsEmail } = require('../lib/email-sender');

// Resumes scored at the same time; keeps well under Gemini's free-tier requests per minute
const CONCURRENCY = 3;
// Stop starting new resumes after this long so the call finishes inside Vercel's 60s limit.
// Whatever is left is reported as `remaining` and picked up by the next call.
const TIME_BUDGET_MS = 35000;

// Run fn over items with at most `limit` in flight, starting no new item after `deadline`.
// Returns results in input order; items never started are left undefined.
async function mapWithLimit(items, limit, deadline, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length && Date.now() < deadline) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const MAX_ANSWERS = 10;

// strengths / gaps are stored in the sheet as JSON strings
function parseList(value) {
  try {
    const list = JSON.parse(value || '[]');
    return Array.isArray(list) ? list.map(String) : [];
  } catch (error) {
    return value ? [String(value)] : [];
  }
}

// Older frontends send exactly four fields, answer1..answer4, for the original fixed
// questions. Turn them into the { question, answer } list used now.
const LEGACY_QUESTIONS = [
  'Role context and what this person must deliver in the first 90 days',
  'Must-have vs. nice-to-have skills',
  'Team environment and working style',
  'Deal-breakers and automatic disqualifiers'
];

function withLegacyAnswers(body) {
  if (body.answers !== undefined || !['answer1', 'answer2', 'answer3', 'answer4'].some(k => k in body)) {
    return body;
  }
  return {
    ...body,
    answers: LEGACY_QUESTIONS.map((question, i) => ({ question, answer: body[`answer${i + 1}`] }))
  };
}

// Returns an error body for a bad answers list, or null when it's fine
function validateAnswers(answers) {
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
  return null;
}

module.exports = async (req, res) => {
  // CORS, method check and optional API key (see lib/http.js)
  if (!prepareRequest(req, res, 'POST')) return;

  try {
    const startedAt = Date.now();
    const body = withLegacyAnswers(req.body || {});

    const { role, force } = body;

    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }

    // HR answers: one { question, answer } per question from generate-questions
    const answerError = validateAnswers(body.answers);
    if (answerError) {
      return res.status(400).json(answerError);
    }
    const hrAnswers = body.answers.map(qa => ({
      question: String(qa.question).trim(),
      answer: String(qa.answer).trim()
    }));

    console.log(`Starting screening for role: ${role} (${hrAnswers.length} HR answers)`);

    // Stored in column G of every scored row; a row counts as done only if it
    // was scored against these exact answers
    const hrAnswersJson = JSON.stringify(hrAnswers);

    // Read all resumes from Google Sheet
    console.log('Reading resumes from Google Sheets...');
    const rows = await readSheet(role);

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'No resumes found for this role',
        role: role
      });
    }

    // force: true starts the run over by clearing the "scored with these answers"
    // marker (column G). Send it on the first call only; follow-up calls without
    // it then continue the new run instead of starting over again.
    if (force) {
      const marked = rows.filter(row => row.jd_clarification === hrAnswersJson);
      await updateRows(role, marked.map(row => ({ row: row.row_number, startColumn: 'G', values: [''] })));
      marked.forEach(row => { row.jd_clarification = ''; });
    }

    const isDone = row => row.jd_clarification === hrAnswersJson;
    const pending = rows.filter(row => !isDone(row));

    console.log(`${rows.length} resumes, ${pending.length} to score`);

    // Score pending resumes in parallel, within the time budget
    const scored = await mapWithLimit(pending, CONCURRENCY, startedAt + TIME_BUDGET_MS, async (row) => {
      console.log(`Scoring resume in row ${row.row_number}...`);
      try {
        const scoring = await scoreResume(row.jd, row.resume, hrAnswers);
        return {
          row_number: row.row_number,
          filename: row.filename,
          candidate_name: scoring.candidate_name || '',
          score: scoring.match_score,
          strengths: JSON.stringify(scoring.strengths || []),
          gaps: JSON.stringify(scoring.gaps || []),
          justification: scoring.justification || '',
          recommendation: scoring.recommendation || '',
          interview_priority: scoring.interview_priority || ''
        };
      } catch (error) {
        console.error(`Error scoring resume in row ${row.row_number}:`, error);
        // Complete placeholder so no stale values from an earlier run survive in the row
        return {
          row_number: row.row_number,
          filename: row.filename,
          candidate_name: row.candidate_name,
          score: 0,
          strengths: '[]',
          gaps: '[]',
          justification: `Failed to score: ${error.message}`,
          recommendation: 'Error',
          interview_priority: ''
        };
      }
    });
    const newResults = scored.filter(Boolean);
    const remaining = pending.length - newResults.length;

    // Everything scored against these answers: earlier calls plus this one
    const newByRow = new Map(newResults.map(r => [r.row_number, r]));
    const results = rows
      .filter(row => newByRow.has(row.row_number) || isDone(row))
      .map(row => newByRow.get(row.row_number) || {
        row_number: row.row_number,
        filename: row.filename,
        candidate_name: row.candidate_name,
        score: Number(row.score) || 0,
        strengths: row.strengths,
        gaps: row.gaps,
        justification: row.justification,
        recommendation: row.recommendation,
        interview_priority: row.interview_priority
      });

    // Sort by score (ties keep sheet order) and add rank
    results.sort((a, b) => b.score - a.score || a.row_number - b.row_number);
    results.forEach((result, index) => {
      result.rank = index + 1;
    });

    console.log('Updating Google Sheets with results...');

    // New results write F–M and O; previously scored rows only get their new rank in F.
    // Columns A–E (jd, resume, uploadedAt, role, questions) and N (filename) are never touched.
    await updateRows(role, results.flatMap(result => {
      if (!newByRow.has(result.row_number)) {
        return [{ row: result.row_number, startColumn: 'F', values: [result.rank] }];
      }
      return [{
        row: result.row_number,
        startColumn: 'O',
        values: [result.candidate_name] // Column O: candidate_name
      }, {
        row: result.row_number,
        startColumn: 'F',
        values: [
          result.rank,                  // Column F: rank
          hrAnswersJson,                // Column G: jd_clarification (HR answers)
          result.score,                 // Column H: score
          result.strengths,             // Column I: strengths
          result.gaps,                  // Column J: gaps
          result.justification,         // Column K: justification
          result.recommendation,        // Column L: recommendation
          result.interview_priority     // Column M: interview_priority
        ]
      }];
    }));

    // Email once, on the call that finishes the run
    let emailSent = false;
    if (remaining === 0 && newResults.length > 0) {
      console.log('Sending email summary...');
      emailSent = await sendResultsEmail(results, role);
    }

    // Return success
    return res.status(200).json({
      success: true,
      message: remaining === 0
        ? 'Screening completed successfully'
        : `Screening in progress: ${remaining} resumes left, call again with the same answers`,
      data: {
        done: remaining === 0,
        remaining: remaining,
        scored_this_call: newResults.length,
        total_candidates: rows.length,
        email_sent: emailSent,
        summary: {
          strong_yes: results.filter(r => r.recommendation === 'Strong Yes').length,
          yes: results.filter(r => r.recommendation === 'Yes').length,
          maybe: results.filter(r => r.recommendation === 'Maybe').length,
          no: results.filter(r => r.recommendation === 'No').length,
          failed: results.filter(r => r.recommendation === 'Error').length
        },
        top_5: results.slice(0, 5).map(r => ({
          rank: r.rank,
          candidate_name: r.candidate_name || '',
          filename: r.filename || '',
          score: r.score,
          recommendation: r.recommendation
        })),
        // Every ranked candidate with the reasoning behind the score, once the run is done
        ...(remaining === 0 && {
          candidates: results.map(r => ({
            rank: r.rank,
            candidate_name: r.candidate_name || '',
            filename: r.filename || '',
            score: r.score,
            recommendation: r.recommendation,
            interview_priority: r.interview_priority || '',
            strengths: parseList(r.strengths),
            gaps: parseList(r.gaps),
            justification: r.justification || ''
          }))
        })
      }
    });

  } catch (error) {
    console.error('Screening error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
