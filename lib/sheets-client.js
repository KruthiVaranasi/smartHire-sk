const { google } = require('googleapis');

// Google Sheets is optional: it's only used to export a finished screening as a new tab.
// Nothing about a screening is stored there while it runs.

// Service account credentials from env. Dashboards and .env files mangle multi-line
// keys in different ways, so GOOGLE_PRIVATE_KEY is accepted with or without
// surrounding quotes, with real or escaped (\n, \\n) line breaks, or as the whole
// service-account JSON file.
function getCredentials() {
  let key = (process.env.GOOGLE_PRIVATE_KEY || '').trim();
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

  if (key.startsWith('{')) {
    try {
      const json = JSON.parse(key);
      key = json.private_key || '';
      email = email || json.client_email;
    } catch (error) {
      throw new Error('GOOGLE_PRIVATE_KEY looks like JSON but could not be parsed');
    }
  }

  key = key
    .replace(/^(["'])([\s\S]*)\1$/, '$2')   // surrounding quotes
    .replace(/\\+r/g, '')                    // escaped carriage returns
    .replace(/\\+n/g, '\n')                  // escaped newlines, single or double
    .replace(/\r/g, '');

  return { client_email: email, private_key: key };
}

function sheetsConfigured() {
  return Boolean(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_PRIVATE_KEY &&
    (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_PRIVATE_KEY.trim().startsWith('{')));
}

function getSheetsApi() {
  const auth = new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Quote a tab name for A1 notation; a ' inside the name is escaped as ''
function tab(sheetName) {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

// Tab titles: keep them short and free of characters spreadsheet apps reject
function cleanTitle(title) {
  return String(title).replace(/[\[\]*?/\\:]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Screening';
}

// Creates a new tab and writes `values` (rows of cells) from A1. If the title is taken,
// "(2)", "(3)"… is appended. Returns { title, url }.
async function createResultsTab(baseTitle, values) {
  const sheets = getSheetsApi();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const base = cleanTitle(baseTitle);

  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const title = attempt === 1 ? base : `${base} (${attempt})`;
      let sheetId;
      try {
        const response = await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title } } }] },
        });
        sheetId = response.data.replies && response.data.replies[0].addSheet.properties.sheetId;
      } catch (error) {
        if (/already exists/i.test(error.message)) continue;
        throw error;
      }

      // RAW: cell text is stored as-is, never run as a formula
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab(title)}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values },
      });

      const gid = sheetId !== undefined ? `#gid=${sheetId}` : '';
      return { title, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit${gid}` };
    }
    throw new Error(`a tab named "${base}" already exists`);
  } catch (error) {
    console.error('Error saving to Google Sheets:', error);
    throw new Error(`Failed to save to Google Sheets: ${error.message}`);
  }
}

module.exports = { createResultsTab, sheetsConfigured };
