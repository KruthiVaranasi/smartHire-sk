# SmartHire

AI resume screening that shows its reasoning. HR uploads resumes and a job description, answers 3-8 clarifying questions written for that role, and gets a ranked shortlist with the strengths, gaps and justification behind every score.

Runs on Vercel with **Google Gemini** (free tier). Nothing about a screening is stored on the server.

## 🚀 Features

- Upload resume PDFs or a .zip (unzipped in the browser, any size)
- Clarifying questions tailored to each job description (3-8, depending on how clear the JD is)
- Every resume scored against the JD **and** HR's answers, with strengths, gaps, justification, recommendation and interview priority
- Ranked shortlist in the browser; **Download CSV**, or **Save to Google Sheet** (optional) with an email summary to HR (optional)
- Resumes are never stored: their text lives only in the browser session
- Optional shared team password

## 📦 Tech Stack

- **Vercel**: hosting for the web app (`public/`) and API (`api/`), free hobby plan
- **Google Gemini 3.8 Flash**: questions and scoring; falls back to 3.5 Flash-Lite when rate limited or unavailable
- **pdf-parse**: PDF text extraction
- **Google Sheets API** (optional): saving finished results
- **Gmail via nodemailer** (optional): summary email

## 🖥️ Web app

- `/`: landing page (the problem, the approach, how it works)
- `/app`: the workspace. Role, JD and resumes → clarifying questions → ranked shortlist → CSV / Google Sheet

Locally, `npm run dev` serves the whole app at http://localhost:3000.

## 🛠️ Setup

### 1. Install

```bash
git clone <your-repo-url>
cd smartHire-sk
npm install
```

### 2. Environment variables

For **local development**, copy `.env.example` to `.env` and fill it in (`.env` is git-ignored; never commit it). For **Vercel**, add the same variables in the project's Settings → Environment Variables, then redeploy.

Required:
- `GEMINI_API_KEY`: free key from https://aistudio.google.com/apikey

Optional:
- `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL`: override the default models (`gemini-3.8-flash` / `gemini-3.5-flash-lite`)
- `APP_PASSWORD`: shared password for the workspace. When set, every API call except `/api/health` and `/api/login` needs a session from `POST /api/login` (sessions last 12 hours; changing the password signs everyone out)
- `API_KEY`: lets server-to-server callers authenticate with an `x-api-key` header instead
- `ALLOWED_ORIGINS`: comma-separated origins allowed to call the API from a browser (the web app's own site is always allowed). Unset means any origin
- Google Sheets export: `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` (see below)
- Email summary: `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `HR_EMAIL`

### 3. Deploy

Connect the GitHub repo to a Vercel project; every push to `main` deploys. Or use the CLI: `npx vercel --prod`.

## 📡 API

| Endpoint | Purpose |
|---|---|
| `POST /api/upload-resume` | Extract text from PDFs or a zip; returns the text and a content `id` per resume. Nothing stored |
| `POST /api/generate-questions` | `{ jd }` → 3-8 clarifying questions |
| `POST /api/score-resumes` | `{ jd, answers, resumes }` → scores for up to 5 resumes per call |
| `POST /api/save-results` | Save a finished, ranked screening as a new Google Sheet tab and email HR (optional) |
| `POST /api/login` | Exchange `APP_PASSWORD` for a session token |
| `GET /api/health` | Which features are configured |

Request and response formats: [WORKFLOW.md](WORKFLOW.md).

## 🔧 Google Sheets export (optional)

1. Create a Google Cloud project and enable the **Google Sheets API**
2. Create a service account and download its JSON key
3. Share your Google Sheet with the service account's email (Editor)
4. Set `GOOGLE_SHEET_ID` (the part of the sheet URL between `/d/` and `/edit`), `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY` (the key can be pasted with or without quotes, or as the whole JSON file)

Each "Save to Google Sheet" creates a new tab named `<role> · <date time>` holding the JD, HR's questions and answers, and one row per candidate. Resume text is never saved.

## 📧 Email summary (optional)

1. Turn on 2-step verification for the Gmail account
2. Create an app password at https://myaccount.google.com/apppasswords
3. Set `GMAIL_USER`, `GMAIL_APP_PASSWORD` and `HR_EMAIL`

## 💰 Cost

**$0/month** on free tiers: Vercel hobby plan, Gemini free tier (limits per project are shown in Google AI Studio), Google Sheets API, Gmail.

## 🔒 Security & privacy

- Resumes are never stored on the server; their text exists only in the browser session and in the requests that score them
- Saved results contain names, scores and reasoning, never resume text
- Set `APP_PASSWORD` so only your team can use the workspace and API
- Resume text is fenced off in the AI prompt, so instructions hidden inside a resume are ignored and flagged
- Exports are safe to open in spreadsheet apps: cells are never run as formulas
- Never commit the `.env` file (already in `.gitignore`)

## 📝 License

MIT
