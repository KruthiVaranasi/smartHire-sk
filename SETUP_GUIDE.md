# Setup Guide - Getting Google Service Account Credentials

This guide will help you get the required Google Service Account credentials to run the resume screener locally.

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a Project" → "New Project"
3. Name it: `resume-screener` (or any name you prefer)
4. Click "Create"

## Step 2: Enable Required APIs

1. In your project, go to **APIs & Services** → **Library**
2. Search and enable these APIs:
   - **Google Sheets API** (to read/write Google Sheets)
   - **Gmail API** (to send email notifications)

## Step 3: Create a Service Account

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **Service Account**
3. Fill in:
   - **Service Account Name**: `resume-screener-bot`
   - **Service Account ID**: Will auto-generate (like `resume-screener-bot@...`)
   - **Description**: `Backend service for resume screening`
4. Click **Create and Continue**
5. Skip "Grant this service account access to project" (optional)
6. Skip "Grant users access to this service account" (optional)
7. Click **Done**

## Step 4: Create a Service Account Key

1. In the **Credentials** page, find your newly created service account
2. Click on the service account email
3. Go to the **Keys** tab
4. Click **Add Key** → **Create new key**
5. Choose **JSON** format
6. Click **Create**
7. A JSON file will download - **SAVE THIS FILE SECURELY!**

## Step 5: Share Your Google Sheet with the Service Account

1. Open the JSON file you just downloaded
2. Find the `client_email` field (looks like: `resume-screener-bot@project-123.iam.gserviceaccount.com`)
3. Open your Google Sheet: https://docs.google.com/spreadsheets/d/your_google_sheet_id/edit
4. Click **Share** button (top right)
5. Paste the service account email
6. Give it **Editor** permissions
7. Click **Send** (uncheck "Notify people" checkbox)

## Step 6: Update Your .env File

Open the JSON credentials file and copy these values to your `.env` file:

```bash
# From the JSON file:
GOOGLE_SERVICE_ACCOUNT_EMAIL=resume-screener-bot@project-123.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour-actual-private-key-here\n-----END PRIVATE KEY-----\n"
```

**Important**: The private key must include the quotes and keep all `\n` characters!

## Step 7: Verify Your .env File

Your complete `.env` file should look like:

```bash
# Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key_here

# Google Sheets Configuration
GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_SERVICE_ACCOUNT_EMAIL=resume-screener-bot@project-123.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour-actual-private-key-here\n-----END PRIVATE KEY-----\n"

# Gmail Configuration (optional - can skip for now)
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=your_gmail_app_password

# HR Email (where to send screening results)
HR_EMAIL=hr_team@example.com
```

## Step 8: Test Everything!

Once your `.env` is configured:

1. **Terminal 1**: Start the Vercel dev server
   ```bash
   cd path/to/smartHire-sk
   npm run dev
   ```

2. **Terminal 2**: Run the test script
   ```bash
   cd path/to/smartHire-sk
   npm test
   ```

The test will:
- Upload 3 resume PDFs
- Generate clarifying questions
- Score all candidates
- Update Google Sheets
- Send email notification

## Gmail Configuration (Optional)

If you want email notifications to work locally:

1. Enable 2FA on your Gmail account
2. Go to: https://myaccount.google.com/apppasswords
3. Generate an App Password
4. Update `.env`:
   ```bash
   GMAIL_USER=your_email@gmail.com
   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx  # The 16-character password
   ```

**Note**: If you skip Gmail setup, the screening will still work, but email sending will fail (non-critical).

## Troubleshooting

### "Permission denied" error on Google Sheets
- Make sure you shared the sheet with the service account email
- Check that you gave "Editor" permissions

### "Invalid credentials" error
- Verify your private key has `\n` characters preserved
- Make sure the private key is wrapped in quotes in .env

### "API not enabled" error
- Go back to Google Cloud Console
- Enable Google Sheets API and Gmail API

### "File not found" error during test
- Put your sample resume PDFs in a `samples` folder next to the repo (or set `RESUMES_DIR` to another folder)

## Next Steps

Once local testing works:
1. Push code to GitHub
2. Deploy to Vercel
3. Add environment variables in Vercel dashboard
4. Update Lovable frontend to call new API endpoints

---

Need help? Check the [README.md](./README.md) or [WORKFLOW.md](./WORKFLOW.md) for more details.
