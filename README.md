# Resume Screener Backend (Vercel)

AI-powered resume screening system converted from n8n workflow using **Google Gemini 3.8 Flash** (FREE tier).

## 🚀 Features

- PDF resume upload & text extraction (single PDFs or a .zip of PDFs)
- AI-powered clarifying questions tailored to each job description (3-8, Google Gemini - FREE)
- Multi-resume scoring against job requirements
- Automated ranking and Google Sheets integration
- Email summary to HR

## 📦 Tech Stack

- **Vercel** - Serverless hosting (FREE)
- **Google Gemini 3.8 Flash** - AI question generation & resume scoring (free tier, falls back to 3.5 Flash-Lite when rate limited)
- **Google Sheets API** - Data storage
- **Gmail API** - Email notifications
- **pdf-parse** - PDF text extraction

## 🖥️ Web app

The repo includes a web front end in `public/`, deployed together with the API:

- `/`: landing page (the problem, the approach, how it works)
- `/app`: the workspace. Add a role and job description, upload PDFs or a zip (unzipped in the browser, so size isn't limited by Vercel's 4.5 MB request cap), answer the AI's questions, and review the ranked shortlist with the reasoning for each candidate

Set `APP_PASSWORD` to require a shared team password for the workspace and the API. Locally, `npm run dev` serves the whole app at http://localhost:3000.

## 🛠️ Setup

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd resume-screener-backend
npm install
```

### 2. Environment Variables

For **local development**, copy `.env.example` to `.env` and fill it in (`.env` is git-ignored; never commit it). For **Vercel**, add the same variables in the project dashboard.

Required variables:
- `GEMINI_API_KEY`: Get FREE key from https://aistudio.google.com/apikey
- `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` (optional): override the default models (`gemini-3.8-flash` / `gemini-3.5-flash-lite`)
- `GOOGLE_SHEET_ID`: Your Google Sheet ID (from URL)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: Service account email
- `GOOGLE_PRIVATE_KEY`: Service account private key
- `GMAIL_USER`: Your Gmail address
- `GMAIL_APP_PASSWORD`: Gmail app-specific password
- `HR_EMAIL`: Email to receive screening results

Optional security variables (see [Security](#-security)):
- `ALLOWED_ORIGINS`: comma-separated origins allowed to call the API from a browser, e.g. `https://your-app.lovable.app`. Unset means any origin.
- `APP_PASSWORD`: shared password for the web app. When set, every API request except `/api/health` and `/api/login` needs a session from `POST /api/login` (sent as `Authorization: Bearer <token>`). Sessions last 12 hours; changing the password signs everyone out.
- `API_KEY`: when set, server-to-server callers can send it in the `x-api-key` header instead.

### 3. Deploy to Vercel

```bash
# Install Vercel CLI
npm install -g vercel

# Login
vercel login

# Deploy
vercel --prod
```

During deployment, you'll be prompted to add environment variables. Add all the variables listed above.

**OR** add them via Vercel Dashboard:
1. Go to your project settings
2. Navigate to "Environment Variables"
3. Add each variable one by one

## 📡 API Endpoints

### POST /api/upload-resume
Upload resumes for a role: one PDF, several PDFs, or a `.zip` of PDFs (subfolders are fine; up to 100 PDFs). Each resume becomes one row in the role's sheet tab.

**Request:** (multipart/form-data)
- `resume_pdf`: PDF or `.zip` file (repeat the field to send several files)
- `jd`: Job description text
- `role`: Role name (matches Google Sheet tab name)

Vercel rejects request bodies over about **4.5 MB**, so a zip sent directly must stay under that. For bigger batches, unzip in the browser and upload the PDFs a few per request.

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
      { "filename": "jane_doe.pdf", "status": "ok", "resumeLength": 5420 },
      { "filename": "scan.pdf", "status": "failed", "error": "No readable text in PDF. It may be empty, corrupt, or a scanned image." }
    ],
    "uploadedAt": "2026-10-05T10:30:00.000Z",
    "jd_preview": "We are looking for..."
  }
}
```

For a single file, `data` also includes `filename` and `resumeLength`.

### POST /api/generate-questions
Generate 3-8 clarifying questions for HR, tailored to the role's job description (fewer for a clear JD, more for a vague or senior one). Call once, after all resumes are uploaded.

**Request:** (JSON) `{ "role": "Senior Engineer" }`

**Response:** `data.questions` is a list of `{ "title": "...", "question": "..." }`, and `data.question_count` says how many. See [WORKFLOW.md](WORKFLOW.md).

### POST /api/submit-screening
Submit HR answers and score the resumes for a role. Each call scores as many resumes as fit in ~35 seconds; **repeat the same request until `data.done` is `true`**. See [WORKFLOW.md](WORKFLOW.md) for details.

**Request:** (JSON)
```json
{
  "role": "Senior Engineer",
  "answers": [
    { "question": "<question 1 from generate-questions>", "answer": "..." },
    { "question": "<question 2 from generate-questions>", "answer": "..." }
  ],
  "force": false
}
```

Send one `{ question, answer }` per question; every answer is required. Older clients sending `answer1`…`answer4` still work.

**Response:**
```json
{
  "success": true,
  "data": {
    "done": true,
    "remaining": 0,
    "scored_this_call": 4,
    "total_candidates": 10,
    "email_sent": true,
    "summary": {
      "strong_yes": 3,
      "yes": 4,
      "maybe": 2,
      "no": 1,
      "failed": 0
    },
    "top_5": [
      { "rank": 1, "candidate_name": "Jane Doe", "filename": "jane_doe.pdf", "score": 88, "recommendation": "Strong Yes" }
    ]
  }
}
```

### GET /api/health
Health check endpoint - verifies all environment variables are configured.

## 🔧 Google Sheets Setup

1. Create a Google Cloud Project: https://console.cloud.google.com/
2. Enable Google Sheets API
3. Create Service Account:
   - Go to "IAM & Admin" → "Service Accounts"
   - Click "Create Service Account"
   - Download JSON key file
4. Share your Google Sheet with the service account email (Editor access)
5. Extract credentials from JSON:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY`

**Sheet Structure:**
Each role should have its own sheet tab (matching the `role` field). Columns:
- A: jd
- B: resume
- C: uploadedAt
- D: role
- E: jd_clarifications
- F: rank
- G: jd_clarification (HR answers this row was scored with)
- H: score
- I: strengths
- J: gaps
- K: justification
- L: recommendation
- M: interview_priority
- N: filename
- O: candidate_name

Tabs are created automatically, and the header row is kept up to date on every upload.

## 📧 Gmail Setup

1. Enable 2-Factor Authentication on your Google account
2. Generate App Password:
   - Go to https://myaccount.google.com/apppasswords
   - Select "Mail" and "Other"
   - Copy the generated password
3. Use this as `GMAIL_APP_PASSWORD` in Vercel

## 💰 Cost

**$0/month** - Everything uses free tiers:
- Vercel: Free hobby plan
- Google Gemini: free tier (per-project limits are shown in Google AI Studio)
- Google Sheets API: Free tier
- Gmail: Free

## 🔒 Security

- Never commit the `.env` file (already in `.gitignore`)
- All secrets managed in Vercel dashboard
- Set `ALLOWED_ORIGINS` to your frontend's URL so other websites can't call the API from a browser
- `API_KEY` blocks anyone without the key, but don't put it in browser code, where anyone can read it. Call the API from a server-side function that holds the key, such as a Supabase edge function in Lovable
- Resume text is fenced off in the AI prompt so instructions hidden inside a resume are ignored
- Use HTTPS endpoints only

## 📝 License

MIT
