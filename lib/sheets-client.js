const { google } = require('googleapis');

// Initialize Google Sheets API
function getGoogleAuth() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
}

// Quote a tab name for A1 notation; a ' inside the name is escaped as ''
function tab(sheetName) {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

// Column layout of every role tab (A to O)
const HEADERS = [
  'jd',                 // A
  'resume',             // B
  'uploadedAt',         // C
  'role',               // D
  'jd_clarifications',  // E: AI questions
  'rank',               // F
  'jd_clarification',   // G: HR answers the row was scored with
  'score',              // H
  'strengths',          // I
  'gaps',               // J
  'justification',      // K
  'recommendation',     // L
  'interview_priority', // M
  'filename',           // N
  'candidate_name'      // O
];

// Ensure the sheet tab exists with the current header row
async function ensureSheetExists(sheetName) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    // Create the tab; "already exists" is the normal case (and how a
    // parallel upload that lost the race to create it finds out)
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                },
              },
            },
          ],
        },
      });
      console.log(`Created new sheet tab: ${sheetName}`);
    } catch (error) {
      if (!/already exists/i.test(error.message)) throw error;
    }

    // Always (re)write the header row before appending. This is idempotent, keeps a
    // racing upload from appending into row 1, and adds new columns to older tabs.
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${tab(sheetName)}!A1:O1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [HEADERS],
      },
    });
  } catch (error) {
    console.error('Error ensuring sheet exists:', error);
    throw new Error('Failed to create sheet tab');
  }
}

// Append rows (each an array of column values from A) in one API call
async function appendRows(sheetName, rows) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    // Ensure the sheet tab exists
    await ensureSheetExists(sheetName);

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${tab(sheetName)}!A:Z`,
      valueInputOption: 'RAW',
      requestBody: {
        values: rows,
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error appending to sheet:', error);
    throw new Error('Failed to write to Google Sheets');
  }
}

async function readSheet(sheetName) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${tab(sheetName)}!A:Z`,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return [];
    }

    // Convert to array of objects
    const headers = rows[0];
    return rows.slice(1).map((row, index) => {
      const obj = { row_number: index + 2 }; // +2 because header is row 1, data starts at row 2
      headers.forEach((header, i) => {
        obj[header] = row[i] || '';
      });
      return obj;
    });
  } catch (error) {
    // No tab for this role yet means no resumes, not a server error
    if (/Unable to parse range/i.test(error.message)) {
      return [];
    }
    console.error('Error reading sheet:', error);
    throw new Error('Failed to read from Google Sheets');
  }
}

// Write several cell ranges in one API call. Each update only touches the
// columns it names, e.g. { row: 5, startColumn: 'F', values: [rank, ...] }
async function updateRows(sheetName, updates) {
  if (updates.length === 0) return;

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.map(({ row, startColumn, values }) => ({
          range: `${tab(sheetName)}!${startColumn}${row}`,
          values: [values],
        })),
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error updating sheet:', error);
    throw new Error('Failed to update Google Sheets');
  }
}

module.exports = { appendRows, readSheet, updateRows };
