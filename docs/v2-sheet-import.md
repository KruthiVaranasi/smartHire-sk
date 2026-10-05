# v2: Import candidates from Google Sheets (with cover letters)

> **Status: 🚧 Work in progress. Not built yet.** This branch holds the design for SmartHire v2.
> The live app (`main`) still takes PDFs or a zip of resumes.

## Why

Many HR teams collect applications with a **Google Form**. Its file-upload questions put each file in Google Drive and add a row per applicant to a responses sheet, with Drive links to the files. Today HR has to download those files and zip them up. In v2, HR pastes the sheet link and SmartHire fetches every resume and cover letter itself.

v2 also adds **cover letters**: optional, one separate file per candidate, read alongside the resume.

## Assumptions

- One row = one candidate
- Every candidate has a resume; the cover letter is optional and is a separate file
- Files are PDFs, Word documents (.docx) or Google Docs

## HR's flow

1. **Paste the sheet link.** SmartHire reads the header row and the first few rows.
2. **Map the columns:** which column holds the resume link, which the cover letter link (optional), and the candidate's name (optional).
3. **Import.** Files are fetched in small batches with a progress bar. Each row ends up ready, or flagged with a reason (no access, dead link, unreadable file, no resume).
4. **Review candidates.** A list of candidates, each showing "resume" or "resume + cover letter". HR can skip flagged rows.
5. Continue as today: role and JD, clarifying questions, scoring, results.

Nothing is stored. As in v1, the browser holds the text for the session.

## API

### `POST /api/import-sheet/preview`
```json
{ "sheet_url": "https://docs.google.com/spreadsheets/d/<id>/edit#gid=0" }
```
Returns the tab's headers, the row count and the first 5 rows, so HR can map the columns. Fails with a clear message if the sheet isn't shared with SmartHire.

### `POST /api/import-sheet/rows`
```json
{
  "sheet_url": "…",
  "columns": { "resume": "Resume", "cover_letter": "Cover letter", "name": "Full name" },
  "start_row": 2,
  "limit": 5
}
```
Fetches and extracts the files for up to 5 rows (to stay inside Vercel's 60-second limit) and returns:
```json
{
  "candidates": [
    {
      "row": 2,
      "name": "Jane Doe",
      "status": "ok",
      "resume": { "id": "3f9a…", "filename": "Jane_Resume.pdf", "text": "…" },
      "cover_letter": { "id": "8b1c…", "filename": "Cover letter.docx", "text": "…" }
    },
    { "row": 3, "name": "Raj Kumar", "status": "failed", "error": "No access to the resume file. Share the uploads folder with SmartHire." }
  ],
  "next_row": 7,
  "done": false
}
```
The browser calls it repeatedly until `done`.

### Scoring with cover letters
`POST /api/score-resumes` accepts an optional `cover_letter` text per resume. Prompt rules:
- Skills and experience are judged on the **resume**
- The cover letter adds motivation, communication and context (e.g. a career gap or a relocation)
- **A missing cover letter is never a penalty**
- Claims that appear only in the cover letter, with no evidence in the resume, are noted as unverified rather than counted

## Reading the files

| Link | How |
|---|---|
| `drive.google.com/file/d/<id>/…`, `…/open?id=<id>`, `…/uc?id=<id>` | Drive API `files.get` with `alt=media` |
| Google Docs (`docs.google.com/document/d/<id>`) | Drive API `files.export` as plain text |
| PDF | existing `pdf-parse` extraction |
| .docx | new: `mammoth` (text only) |
| Several links in one cell (Forms allow multiple uploads) | first file is the resume; the rest are flagged for review |

## Access

**Phase 1: service account (no sign-in).** HR shares the responses sheet and the Form's uploads folder in Drive with the SmartHire service account email (one share each; Viewer is enough). Needs the Google Drive API enabled and the `drive.readonly` scope. The UI shows the email to share with and explains the error when access is missing.

**Phase 2: "Sign in with Google" (OAuth).** HR signs in and SmartHire reads with *their* access, so there's no sharing step. This also replaces the shared password.

## Also in v2 (offline alternative)

**One zip, one folder per candidate:** each folder holds the resume and an optional cover letter. Within a folder, a name containing "cover" or "letter" marks the cover letter; otherwise the content decides (a letter opens with "Dear…" and is written in paragraphs; a resume has sections such as Experience and Education). Folders with no resume or more than two files are flagged for review.

## Effort

| Piece | Estimate |
|---|---|
| Sheet preview + column mapping UI | ~2-3 h |
| Drive fetch, link parsing, Docs export, .docx | ~3 h |
| Batched import + per-row errors + review screen | ~2-3 h |
| Cover letters in scoring prompt + UI | ~1-2 h |
| Folder-per-candidate zip | ~3-4 h |
| Tests | ~2 h |

## Open questions

- Should HR be able to filter rows before importing (e.g. by a "Position" column, when one Form collects several roles)?
- Should the cover letter be shown next to the reasoning on the results screen?
- Large sheets: a cap per screening (e.g. 200 candidates) to stay within Gemini's free tier?
