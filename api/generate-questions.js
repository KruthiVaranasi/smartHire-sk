const { prepareRequest } = require('../lib/http');
const { generateQuestions } = require('../lib/gemini-client');

const MAX_JD_CHARS = 20000;

// Writes 3-8 clarifying questions for HR, tailored to the job description
module.exports = async (req, res) => {
  // CORS, method check and sign-in (see lib/http.js)
  if (!prepareRequest(req, res, 'POST')) return;

  try {
    const jd = String((req.body || {}).jd || '').trim();

    if (jd.length < 30) {
      return res.status(400).json({ error: 'Job description (jd) is required' });
    }
    if (jd.length > MAX_JD_CHARS) {
      return res.status(400).json({ error: `Job description is too long (max ${MAX_JD_CHARS} characters)` });
    }

    console.log('Generating clarifying questions with Gemini AI...');
    const questions = await generateQuestions(jd);
    console.log(`Generated ${questions.length} questions`);

    return res.status(200).json({
      success: true,
      message: 'Questions generated successfully',
      data: {
        question_count: questions.length,
        questions
      }
    });

  } catch (error) {
    console.error('Generate questions error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
