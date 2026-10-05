const AdmZip = require('adm-zip');

// Guards against zip bombs and runaway batches
const MAX_PDFS = 100;
const MAX_PDF_BYTES = 10 * 1024 * 1024;     // per file, uncompressed
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;  // whole archive, uncompressed

// Returns [{ filename, buffer }] for every PDF in the zip (including subfolders),
// skipping macOS metadata and hidden files
function extractPdfsFromZip(zipBuffer) {
  let entries;
  try {
    entries = new AdmZip(zipBuffer).getEntries();
  } catch (error) {
    throw new Error('Could not read zip file. Is it a valid .zip?');
  }

  const pdfs = entries.filter(entry =>
    !entry.isDirectory &&
    /\.pdf$/i.test(entry.name) &&
    !entry.entryName.startsWith('__MACOSX/') &&
    !entry.name.startsWith('.')
  );

  if (pdfs.length === 0) {
    throw new Error('No PDF files found in zip');
  }
  if (pdfs.length > MAX_PDFS) {
    throw new Error(`Too many PDFs in zip (${pdfs.length}, max ${MAX_PDFS})`);
  }

  // header.size is the declared uncompressed size, checked before anything is inflated
  const total = pdfs.reduce((sum, entry) => sum + entry.header.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`Zip contents too large (max ${MAX_TOTAL_BYTES / 1024 / 1024} MB uncompressed)`);
  }

  return pdfs.map(entry => {
    if (entry.header.size > MAX_PDF_BYTES) {
      return { filename: entry.name, error: `File too large (max ${MAX_PDF_BYTES / 1024 / 1024} MB)` };
    }
    return { filename: entry.name, buffer: entry.getData() };
  });
}

module.exports = { extractPdfsFromZip };
