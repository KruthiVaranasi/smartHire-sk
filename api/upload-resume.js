const { prepareRequest } = require('../lib/http');
const Busboy = require('busboy');
const { extractTextFromPDF } = require('../lib/pdf-extractor');
const { extractPdfsFromZip } = require('../lib/zip-extractor');

const { fingerprint } = require('../lib/fingerprint');

// Helper to parse multipart form data. Collects every uploaded file, so a request
// can carry one PDF, several PDFs, or a zip of PDFs.
function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    const files = [];

    busboy.on('field', (fieldname, val) => {
      fields[fieldname] = val;
    });

    busboy.on('file', (fieldname, file, info) => {
      const chunks = [];
      file.on('data', (data) => chunks.push(data));
      file.on('end', () => {
        files.push({ filename: info.filename, mimeType: info.mimeType, buffer: Buffer.concat(chunks) });
      });
    });

    busboy.on('finish', () => {
      resolve({ fields, files });
    });

    busboy.on('error', reject);

    req.pipe(busboy);
  });
}

const isZip = (file) => /\.zip$/i.test(file.filename || '') || /zip/i.test(file.mimeType || '');

// Extract and clean the text of one resume PDF
async function processResume(buffer) {
  const resumeText = await extractTextFromPDF(buffer);

  if (!resumeText || resumeText.trim().length < 50) {
    throw new Error('No readable text in PDF. It may be empty, corrupt, or a scanned image.');
  }

  // Clean extracted text, keeping line breaks so sections and bullets stay readable
  return resumeText
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Very long extractions are trimmed; real resumes are far shorter than this
const MAX_RESUME_CHARS = 40000;

// Extracts the text of every uploaded PDF (or PDFs inside a zip) and returns it.
// Nothing is stored: the browser keeps the text for the rest of the screening.
module.exports = async (req, res) => {
  // CORS, method check and sign-in (see lib/http.js)
  if (!prepareRequest(req, res, 'POST')) return;

  try {
    const { files } = await parseMultipartForm(req);

    if (files.length === 0 || files.every(f => f.buffer.length === 0)) {
      return res.status(400).json({ error: 'Resume PDF (or a .zip of PDFs) is required' });
    }

    // Expand zips into their PDFs
    const pdfs = [];
    for (const file of files) {
      if (!isZip(file)) {
        pdfs.push(file);
        continue;
      }
      try {
        pdfs.push(...extractPdfsFromZip(file.buffer));
      } catch (error) {
        return res.status(400).json({ error: `${file.filename}: ${error.message}` });
      }
    }

    console.log(`Extracting ${pdfs.length} resume(s)...`);

    // One bad file doesn't stop the others. `id` identifies the resume by its content,
    // so the browser can skip a resume it already has, whatever the file is called.
    const seen = new Set();
    const report = [];
    for (const pdf of pdfs) {
      if (pdf.error) {
        report.push({ filename: pdf.filename, status: 'failed', error: pdf.error });
        continue;
      }
      try {
        const text = await processResume(pdf.buffer);
        const id = fingerprint(text);
        if (seen.has(id)) {
          report.push({ filename: pdf.filename, status: 'duplicate', id, error: 'Same resume as another file in this upload' });
          continue;
        }
        seen.add(id);
        report.push({
          filename: pdf.filename,
          status: 'ok',
          id,
          resumeLength: text.length,
          resume: text.slice(0, MAX_RESUME_CHARS)
        });
      } catch (error) {
        console.error(`Failed to process ${pdf.filename}:`, error.message);
        report.push({ filename: pdf.filename, status: 'failed', error: error.message });
      }
    }

    const ok = report.filter(r => r.status === 'ok').length;
    const duplicates = report.filter(r => r.status === 'duplicate').length;
    const failed = report.filter(r => r.status === 'failed').length;

    if (ok === 0 && duplicates === 0) {
      return res.status(400).json({ error: 'None of the uploaded resumes could be read', files: report });
    }

    return res.status(200).json({
      success: true,
      message: [`${ok} resume(s) read`, duplicates && `${duplicates} duplicate(s)`, failed && `${failed} failed`].filter(Boolean).join(', '),
      data: { uploaded: ok, duplicates, failed, files: report }
    });

  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
