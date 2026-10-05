const pdf = require('pdf-parse');

// pdf-parse occasionally fails on the first PDF parsed by a freshly started
// serverless instance and then succeeds on the same file, so try once more
// before reporting the file as unreadable.
const ATTEMPTS = 2;

async function extractTextFromPDF(buffer) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const data = await pdf(buffer);
      return data.text;
    } catch (error) {
      lastError = error;
      console.error(`PDF extraction error (attempt ${attempt}/${ATTEMPTS}):`, error.message || error);
    }
  }
  throw new Error(`Failed to extract text from PDF: ${lastError.message || 'unknown error'}`);
}

module.exports = { extractTextFromPDF };
