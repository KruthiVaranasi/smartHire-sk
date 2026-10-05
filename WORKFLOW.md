# Complete Workflow Documentation

## 📋 3-Step Process

### **Step 1: Upload Resumes**

**Endpoint:** `POST /api/upload-resume`

**Purpose:** HR uploads the resumes for a role: one PDF at a time, several PDFs at once, or a `.zip` of PDFs

**Input:** (form-data)
- `resume_pdf`: a PDF or a `.zip` of PDFs. Repeat the field to send several files in one request
- `jd`: Job description text
- `role`: Job title / role name

**What happens:**
1. Zips are unpacked: every PDF inside is used, including in subfolders (max 100 PDFs; `__MACOSX` and hidden files are skipped)
2. Text is extracted from each PDF. A PDF with no readable text (empty, corrupt, or a scanned image) is reported as failed; the others still go through
3. One row per resume is saved to Google Sheets under a tab named `{role}`: jd, resume, uploadedAt, role and filename

**Size limit:** Vercel rejects request bodies over about **4.5 MB**, so a zip sent directly must stay under that (roughly 15-30 typical resumes). For bigger batches, unzip in the browser and upload the PDFs a few per request.

**Response:**
```json
{
  "success": true,
  "message": "4 resume(s) uploaded, 1 failed",
  "data": {
    "role": "Senior Engineer",
    "uploaded": 4,
    "failed": 1,
    "files": [
      { "filename": "john_doe.pdf", "status": "ok", "resumeLength": 5420 },
      { "filename": "scan.pdf", "status": "failed", "error": "No readable text in PDF. It may be empty, corrupt, or a scanned image." }
    ],
    "uploadedAt": "2026-10-05T10:30:00.000Z",
    "jd_preview": "We are looking for..."
  }
}
```

When exactly one file is uploaded, `data` also has `filename` and `resumeLength`. If no file could be read, the response is a `400` with the same `files` report.

**Lovable calls this:** For each resume, or once with a zip

---

### **Step 2: Generate Questions (Once per role)**

**Endpoint:** `POST /api/generate-questions`

**Purpose:** After all resumes are uploaded, generate clarifying questions for HR

**Input:**
```json
{
  "role": "Senior Engineer"
}
```

**What happens:**
1. Reads the JD from the first row of the role's sheet tab
2. Gemini writes **3 to 8** questions tailored to that JD: fewer for a clear, specific JD, more for a vague or senior one. Topics include role context and urgency, must-have skills, team and working style, deal-breakers, and anything else the JD leaves ambiguous
3. Writes a readable copy of the questions to column E of every row

**Response:**
```json
{
  "success": true,
  "message": "Questions generated successfully",
  "data": {
    "role": "Senior Engineer",
    "total_resumes": 10,
    "question_count": 5,
    "questions": [
      {
        "title": "Primary Language and Stack Focus",
        "question": "The JD lists Node.js, Python, Java, and Go. Is there a single primary language required for Day 1 productivity...?"
      },
      {
        "title": "Urgency and First 90 Days Deliverables",
        "question": "Why does this role exist right now, and what must the candidate deliver within their first 90 days?"
      }
    ],
    "jd_preview": "We are looking for..."
  }
}
```

The number of questions varies, so show however many come back.

**Lovable calls this:** Once, after HR finishes uploading all resumes

---

### **Step 3: Screen & Rank**

**Endpoint:** `POST /api/submit-screening`

**Purpose:** HR answers the questions; the system scores and ranks every candidate

**Input:** one `{ question, answer }` per question from step 2, in the same order
```json
{
  "role": "Senior Engineer",
  "answers": [
    { "question": "The JD lists Node.js, Python, Java, and Go. Is there a single primary language...?", "answer": "Node.js or Python, 5+ years in production" },
    { "question": "Why does this role exist right now...?", "answer": "Critical for our Q2 payments launch" }
  ],
  "force": false
}
```

- Every question needs a non-empty answer (max 10). A missing answer returns `400` with `missing_answers: [2]` (question numbers).
- `force` is optional. Set it to `true` on the **first** call only, to re-score resumes that were already scored with these same answers.
- Older frontends can still send `answer1`…`answer4` (the original four fixed questions); they are converted automatically.

**What happens:**
1. Reads all resumes from Google Sheets for this role
2. Picks the resumes not yet scored with these exact answers (changing any answer re-scores everything)
3. Scores them with Gemini AI, 3 at a time, for up to ~35 seconds so the call stays inside Vercel's 60s limit. HR's answers are treated as the real priorities and override the JD where they disagree
4. Produces for each resume: candidate name, score (0-100), strengths, gaps, justification, recommendation and interview priority. A resume the AI can't score gets score 0 and recommendation `Error`
5. Ranks every resume scored so far and writes columns F–M and O (columns A–E and N are never touched)
6. When the last resume is scored, sends the email summary to HR (once)

**Call it in a loop.** Large batches take several calls. Repeat the same request (without `force`) until `data.done` is `true`; `data.remaining` shows progress.

**Response:**
```json
{
  "success": true,
  "message": "Screening completed successfully",
  "data": {
    "done": true,
    "remaining": 0,
    "scored_this_call": 4,
    "total_candidates": 10,
    "email_sent": true,
    "summary": {
      "strong_yes": 2,
      "yes": 4,
      "maybe": 3,
      "no": 1,
      "failed": 0
    },
    "top_5": [
      { "rank": 1, "candidate_name": "Deep M. Mehta", "filename": "deep_mehta.pdf", "score": 85, "recommendation": "Strong Yes" },
      { "rank": 2, "candidate_name": "Charles McTurland", "filename": "charles.pdf", "score": 78, "recommendation": "Yes" }
    ]
  }
}
```

**Lovable calls this:** After HR answers the questions, repeating until `data.done` is `true`

---

## 🖥️ What the Lovable frontend needs

| Change | Required? | What to do |
|---|---|---|
| Screening loop | **Yes** | Repeat `POST /api/submit-screening` with the same body until `data.done` is `true`. Show `data.remaining` as progress |
| Variable questions | **Yes** | Render one answer box per item in `data.questions` (3-8), then send `answers: [{ question, answer }]` |
| Candidate names | Optional | Show `candidate_name` and `filename` from `top_5` |
| Upload report | Optional | Show `data.files` so HR can see which PDFs failed and why |
| Zip upload | Optional | Allow `.zip` in the file picker for small batches (under ~4.5 MB). For bigger ones, unzip in the browser (e.g. JSZip) and upload the PDFs a few at a time |
| API key | Only if `API_KEY` is set | Call the API from a server-side function that holds the key, never from browser code |

---

## 📊 Complete Google Sheets Schema

Each role has its own sheet tab (tab name = role name). The tab and its header row are created automatically, and the header row is refreshed on every upload.

### **After Step 1 (Upload):**
| Col | Name | Type | Example |
|-----|------|------|---------|
| A | jd | text | "We are looking for a Senior Engineer with..." |
| B | resume | text | "JOHN DOE\nSenior Software Engineer..." |
| C | uploadedAt | timestamp | "2026-10-05T10:30:00.000Z" |
| D | role | text | "Senior Engineer" |
| N | filename | text | "john_doe.pdf" |

### **After Step 2 (Questions):**
| Col | Name | Type | Example |
|-----|------|------|---------|
| E | jd_clarifications | text | "1. Primary Language and Stack Focus\nThe JD lists..." |

### **After Step 3 (Screening):**
| Col | Name | Type | Example |
|-----|------|------|---------|
| F | rank | number | 1 |
| G | jd_clarification | JSON string | '[{"question":"...","answer":"..."}]' (the HR answers this row was scored with) |
| H | score | number | 92 |
| I | strengths | JSON array | '["7 years Python experience","Led ML team"]' |
| J | gaps | JSON array | '["No Kubernetes experience","Limited AWS"]' |
| K | justification | text | "Strong candidate with extensive ML background..." |
| L | recommendation | text | "Strong Yes" (or "Error" if the AI couldn't score it) |
| M | interview_priority | text | "High" |
| O | candidate_name | text | "John Doe" |

---

## 📧 Email Sent to HR (After Step 3)

Sent once, when the last resume of a run is scored, and only if Gmail is configured.

**Subject:** ✅ Resume Screening Complete - 10 Candidates Analyzed (Senior Engineer)

**Body:**
```
Hi HR Team,

Resume screening has completed successfully for role: Senior Engineer

📊 SUMMARY:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Candidates: 10

Recommendations:
  ✅ Strong Yes: 2
  ✓  Yes: 4
  ⚠️  Maybe: 3
  ❌ No: 1

🏆 TOP CANDIDATES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. Deep M. Mehta (deep_mehta.pdf): 85/100, Strong Yes
  2. Charles McTurland (charles.pdf): 78/100, Yes
  ...

📋 NEXT STEPS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Review detailed results in Google Sheet:
   https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit
...
```

If some resumes couldn't be scored, the summary adds a "⛔ Could not be scored: N" line.

---

## 🔄 Complete Flow Diagram

```
┌─────────────────────────────────────────────────┐
│  LOVABLE FRONTEND                               │
└─────────────────────────────────────────────────┘
                    ↓
   [Upload PDFs one by one, or a .zip]
                    ↓
POST /api/upload-resume   (once per file or batch)
                    ↓
   ┌────────────────────────────────┐
   │  Google Sheets                 │
   │  Columns A-D, N                │
   │  (jd, resume, date, role, file)│
   └────────────────────────────────┘
                    ↓
   [HR clicks "Generate Questions"]
                    ↓
POST /api/generate-questions
                    ↓
   ┌────────────────────────────┐
   │  Google Sheets             │
   │  Column E (questions)      │
   └────────────────────────────┘
                    ↓
   [Lovable shows the 3-8 questions to HR]
                    ↓
   [HR answers them]
                    ↓
POST /api/submit-screening   ← repeat until data.done
                    ↓
   ┌────────────────────────────┐
   │  Gemini AI scores          │
   │  3 resumes at a time       │
   └────────────────────────────┘
                    ↓
   ┌────────────────────────────┐
   │  Google Sheets             │
   │  Columns F-M, O            │
   │  (rank, score, name, ...)  │
   └────────────────────────────┘
                    ↓
   ┌────────────────────────────┐
   │  Email sent to HR (once)   │
   └────────────────────────────┘
                    ↓
   [Lovable shows summary]
```

---

## 🧪 Testing the Flow

### Locally

```bash
npm run dev     # terminal 1: local server on http://localhost:3000
npm test        # terminal 2: uploads every PDF in ../samples, generates questions, screens
```

### With curl

**1. Upload resumes (a PDF or a zip):**
```bash
curl -X POST https://your-vercel-url.vercel.app/api/upload-resume \
  -F "resume_pdf=@resumes.zip" \
  -F "jd=We are looking for a Senior Engineer..." \
  -F "role=Senior Engineer"
```

**2. Generate questions:**
```bash
curl -X POST https://your-vercel-url.vercel.app/api/generate-questions \
  -H "Content-Type: application/json" \
  -d '{"role":"Senior Engineer"}'
```

**3. Submit screening (repeat until "done": true):**
```bash
curl -X POST https://your-vercel-url.vercel.app/api/submit-screening \
  -H "Content-Type: application/json" \
  -d '{
    "role": "Senior Engineer",
    "answers": [
      { "question": "<question 1 from step 2>", "answer": "Critical for Q2 launch" },
      { "question": "<question 2 from step 2>", "answer": "5+ years Python, ML experience" }
    ]
  }'
```

If `API_KEY` is set on the server, add `-H "x-api-key: <your key>"` to each request.

---

## ✅ Checklist for HR

- [ ] Upload all resumes for a role (Step 1: one by one or as a zip)
- [ ] Check the upload report for PDFs that couldn't be read
- [ ] Click "Generate Questions" (Step 2: once)
- [ ] Answer every question (Step 3)
- [ ] Review email and Google Sheet results
- [ ] Schedule interviews with top candidates
