const pdf = require('pdf-parse');

async function extractTextFromPDF(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text;
  } catch (error) {
    console.error('PDF extraction error:', error);
    throw new Error('Failed to extract text from PDF');
  }
}

module.exports = { extractTextFromPDF };
