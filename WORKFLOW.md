# How SmartHire Works

SmartHire is **stateless**: the server stores nothing about a screening. The browser keeps the
resumes' text, the questions, HR's answers and the scores for the session, and sends each API
call what it needs. Results are kept by downloading a CSV or saving them to Google Sheets at the end.

```
Browser (public/app.html)                         API (Vercel functions)
─────────────────────────                         ──────────────────────
1. HR adds PDFs or a zip ───── PDFs, 3 per call ──► POST /api/upload-resume
   (zips unpacked in the browser)   ◄── text + id ─  extracts text, nothing saved

2. HR enters role + JD ───────────── { jd } ──────► POST /api/generate-questions
   HR answers 3-8 questions  ◄──── questions ──────  Gemini writes questions for this JD

3. Scoring ──── { jd, answers, 3 resumes } per call ► POST /api/score-resumes
   (repeats until all are scored) ◄── scores ──────  Gemini scores each resume
   Browser ranks the results

4. Keep the results
   · Download CSV (in the browser)
   · Save to Google Sheet ──── ranked results ─────► POST /api/save-results
                              ◄── sheet link ─────  new tab + email summary (if configured)
```

Every call needs a session when `APP_PASSWORD` is set (see [Sign-in](#sign-in)).

---

## POST /api/upload-resume

Extracts the text from resume PDFs. Nothing is stored.

**Request:** `multipart/form-data` with one or more `resume_pdf` files. Each can be a PDF or a `.zip` of PDFs (subfolders are fine, up to 100 PDFs). Vercel rejects bodies over about 4.5 MB, so send a few PDFs per request; the web app unzips in the browser and sends 3 at a time.

**Response (200):**
```json
{
  "success": true,
  "message": "3 resume(s) read, 1 failed",
  "data": {
    "uploaded": 3, "duplicates": 0, "failed": 1,
    "files": [
      { "filename": "jane_doe.pdf", "status": "ok", "id": "3f9a…", "resumeLength": 5420, "resume": "JANE DOE\nSenior Engineer\n…" },
      { "filename": "scan.pdf", "status": "failed", "error": "No readable text in PDF. It may be empty, corrupt, or a scanned image." }
    ]
  }
}
```

- `id` is a fingerprint of the resume's text: the same resume gets the same `id` whatever the file is called. Use it to skip resumes you already have.
- `status: "duplicate"` means the same resume appeared twice in this request.
- If no file could be read, the response is `400` with the same `files` report.

---

## POST /api/generate-questions

**Request:** `{ "jd": "<job description>" }`

**Response (200):**
```json
{
  "success": true,
  "data": {
    "question_count": 4,
    "questions": [
      { "title": "Primary Language and Tech Stack", "question": "The JD lists Node.js, Python, Java and Go. Is one of them required on day 1…?" }
    ]
  }
}
```

The AI picks 3-8 questions depending on how clear the JD is, so the count varies. Generate them once per screening and keep them; each call returns a new set.

---

## POST /api/score-resumes

Scores up to 5 resumes per call (the web app sends 3). Call it repeatedly until every resume is scored, then rank the combined results by `score`.

**Request:**
```json
{
  "jd": "<job description>",
  "answers": [ { "question": "<question text>", "answer": "<HR's answer>" } ],
  "resumes": [ { "id": "3f9a…", "filename": "jane_doe.pdf", "resume": "<text from upload-resume>" } ]
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "scored": 3, "failed": 0,
    "results": [
      {
        "id": "3f9a…", "filename": "jane_doe.pdf", "candidate_name": "Jane Doe",
        "score": 86, "score_breakdown": { "technical_skills": 36, "experience": 26, "cultural_fit": 16, "potential": 8 },
        "strengths": ["…"], "gaps": ["…"], "justification": "…",
        "recommendation": "Strong Yes", "interview_priority": "High"
      }
    ]
  }
}
```

- Results come back in the same order as `resumes`.
- A resume the AI couldn't score comes back with `recommendation: "Error"`, score 0 and the reason in `justification`; the others in the batch are unaffected.
- `400` responses explain what's wrong, e.g. `{ "error": "Every question needs an answer", "missing_answers": [2] }`.

---

## POST /api/save-results

Optional. Saves a finished screening as a **new tab** in the Google Sheet (when Sheets is configured) and emails HR a summary with a link to it (when Gmail is configured). Resume text is never saved.

**Request:**
```json
{
  "role": "Senior Backend Engineer",
  "jd": "<job description>",
  "answers": [ { "question": "…", "answer": "…" } ],
  "results": [ { "candidate_name": "…", "filename": "…", "score": 86, "recommendation": "…", "interview_priority": "…", "strengths": ["…"], "gaps": ["…"], "justification": "…" } ]
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "saved_to_sheet": true,
    "sheet_url": "https://docs.google.com/spreadsheets/d/<id>/edit#gid=123",
    "tab": "Senior Backend Engineer · 2026-10-05 15.20",
    "email_sent": true
  }
}
```

The tab holds the role, date, JD and each question with HR's answer, then one row per candidate: rank, name, file, score, recommendation, interview priority, strengths, gaps and justification.

---

## Sign-in

When `APP_PASSWORD` is set, every endpoint except `/api/health` and `/api/login` needs a session:

1. `POST /api/login` with `{ "password": "…" }` returns `{ "token": "…" }` (valid 12 hours).
2. Send `Authorization: Bearer <token>` on every call.

A `401` with `"auth": "password"` means the session is missing or expired. Server-to-server callers can use `API_KEY` in an `x-api-key` header instead.

## GET /api/health

Public. Reports which features are configured (`sheets_configured`, `gmail_configured`, `password_required`, …) so a front end can show or hide them.

---

## Testing locally

```bash
npm run dev     # terminal 1: app + API on http://localhost:3000
npm test        # terminal 2: reads the PDFs in ../samples, asks questions, scores, saves (if configured)
```
