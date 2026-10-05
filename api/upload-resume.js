const { prepareRequest } = require('../lib/http');
const Busboy = require('busboy');
const { extractTextFromPDF } = require('../lib/pdf-extractor');
const { extractPdfsFromZip } = require('../lib/zip-extractor');
const { appendRows } = require('../lib/sheets-client');

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

module.exports = async (req, res) => {
  // CORS, method check and optional API key (see lib/http.js)
  if (!prepareRequest(req, res, 'POST')) return;

  try {
    console.log('Parsing upload request...');
    const { fields, files } = await parseMultipartForm(req);

    // Validate inputs
    const jd = fields.jd || fields.job_description;
    const role = fields.role;

    if (!jd) {
      return res.status(400).json({ error: 'Job description (jd) is required' });
    }

    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }

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

    console.log(`Processing ${pdfs.length} resume(s) for role: ${role}`);

    // Extract every PDF; one bad file doesn't stop the others
    const uploadedAt = new Date().toISOString();
    const report = [];
    const rows = [];
    for (const pdf of pdfs) {
      if (pdf.error) {
        report.push({ filename: pdf.filename, status: 'failed', error: pdf.error });
        continue;
      }
      try {
        const resume = await processResume(pdf.buffer);
        report.push({ filename: pdf.filename, status: 'ok', resumeLength: resume.length });
        // Columns A–D, blanks for E–M (filled by later steps), then N: filename
        rows.push([jd, resume, uploadedAt, role, '', '', '', '', '', '', '', '', '', pdf.filename]);
      } catch (error) {
        console.error(`Failed to process ${pdf.filename}:`, error.message);
        report.push({ filename: pdf.filename, status: 'failed', error: error.message });
      }
    }

    const failed = report.filter(r => r.status === 'failed').length;

    if (rows.length === 0) {
      return res.status(400).json({
        error: 'None of the uploaded resumes could be read',
        files: report
      });
    }

    // All rows in one Sheets call
    console.log(`Adding ${rows.length} resume(s) to Google Sheets...`);
    await appendRows(role, rows);

    const single = report.length === 1 ? report[0] : null;

    // Return success
    return res.status(200).json({
      success: true,
      message: failed === 0
        ? `${rows.length} resume(s) uploaded successfully`
        : `${rows.length} resume(s) uploaded, ${failed} failed`,
      data: {
        // filename / resumeLength kept for single-file callers
        ...(single && { filename: single.filename, resumeLength: single.resumeLength }),
        role,
        uploaded: rows.length,
        failed,
        files: report,
        uploadedAt,
        jd_preview: jd.substring(0, 200) + '...'
      }
    });

  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
