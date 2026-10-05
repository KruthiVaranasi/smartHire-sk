const { prepareRequest } = require('../lib/http');
const { readSheet, updateRows } = require('../lib/sheets-client');
const { generateQuestions } = require('../lib/gemini-client');

module.exports = async (req, res) => {
  // CORS, method check and optional API key (see lib/http.js)
  if (!prepareRequest(req, res, 'POST')) return;

  try {
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ error: 'Role (job_title) is required' });
    }

    console.log(`Generating questions for role: ${role}`);

    // Read the first row from the sheet to get the JD
    const rows = await readSheet(role);

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'No resumes found for this role. Upload resumes first.',
        role: role
      });
    }

    // Get JD from first row (all rows should have same JD)
    const jd = rows[0].jd;

    if (!jd) {
      return res.status(400).json({
        error: 'Job description not found in sheet'
      });
    }

    console.log('Generating clarifying questions with Gemini AI...');

    // Generate questions using Gemini AI; how many depends on the JD
    const questions = await generateQuestions(jd);

    console.log(`Generated ${questions.length} questions. Updating all rows...`);

    // Readable copy of the questions for HR looking at the sheet
    const questionsText = questions
      .map((q, i) => `${i + 1}. ${q.title}\n${q.question}`)
      .join('\n\n');

    // Write only column E (jd_clarifications) for every row, in one call
    await updateRows(role, rows.map(row => ({
      row: row.row_number,
      startColumn: 'E',
      values: [questionsText]
    })));

    // Return success with questions
    return res.status(200).json({
      success: true,
      message: 'Questions generated successfully',
      data: {
        role: role,
        total_resumes: rows.length,
        question_count: questions.length,
        questions: questions,
        jd_preview: jd.substring(0, 200) + '...'
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
