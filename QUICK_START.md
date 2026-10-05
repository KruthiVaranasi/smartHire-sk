# ⚡ Quick Start - Get Credentials in 3 Minutes

## Step 1: Create Google Cloud Project (30 seconds)

1. Go to: https://console.cloud.google.com/
2. Click **"Select a Project"** (top left) → **"New Project"**
3. **Project Name**: `resume-screener`
4. Click **"Create"**
5. Wait for it to create, then **select the project** from the dropdown

## Step 2: Enable APIs (30 seconds)

1. In your project, click the hamburger menu (☰) → **"APIs & Services"** → **"Library"**
2. Search: **"Google Sheets API"** → Click it → Click **"Enable"**
3. Search: **"Gmail API"** → Click it → Click **"Enable"**

## Step 3: Create Service Account (1 minute)

1. Go to: **"APIs & Services"** → **"Credentials"**
2. Click **"Create Credentials"** (top) → **"Service Account"**
3. Fill in:
   - **Service account name**: `resume-screener-bot`
   - **Service account ID**: (auto-filled, leave it)
   - **Description**: `Backend bot for resume screening`
4. Click **"Create and Continue"**
5. Skip the next 2 steps (click **"Continue"** then **"Done"**)

## Step 4: Download Key (30 seconds)

1. On the **Credentials** page, find your service account in the list
2. Click on the **email** (like: `resume-screener-bot@...`)
3. Go to the **"Keys"** tab
4. Click **"Add Key"** → **"Create new key"**
5. Choose **"JSON"**
6. Click **"Create"**
7. **JSON file downloads** - save it to Downloads folder!

## Step 5: Share Google Sheet (30 seconds)

1. Open your downloaded JSON file
2. Copy the **`client_email`** value (looks like: `resume-screener-bot@project-123.iam.gserviceaccount.com`)
3. Open your Google Sheet: https://docs.google.com/spreadsheets/d/your_google_sheet_id/edit
4. Click **"Share"** button (top right)
5. Paste the email → Give **"Editor"** access
6. **Uncheck** "Notify people"
7. Click **"Share"**

## ✅ Done! Tell Claude the path to your JSON file

Example: `~/Downloads/resume-screener-123abc-456def.json`

Claude will automatically update your `.env` file!
