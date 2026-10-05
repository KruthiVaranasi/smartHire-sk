/**
 * End-to-end test against the local server (npm run dev):
 * 1. Read every PDF in ../samples (or RESUMES_DIR)
 * 2. Generate clarifying questions from the JD
 * 3. Score the resumes in batches with sample HR answers
 * 4. Save the results to Google Sheets / email, if those are configured
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config();

const BASE = process.env.API_BASE || 'http://localhost:3000/api';
const RESUMES_DIR = process.env.RESUMES_DIR || path.join(__dirname, '..', 'samples');
const ROLE = 'Senior Backend Engineer (local test)';
const SCORE_BATCH = 3;

const JD = `We are seeking a Senior Software Development Engineer with 5+ years of experience in building scalable backend systems.

Key Responsibilities:
- Design and implement microservices using Node.js, Python, or Java
- Build RESTful APIs and integrate with cloud services (AWS/GCP/Azure)
- Optimize database queries and system performance
- Mentor junior engineers and lead technical discussions

Required Skills:
- 5+ years of software development experience
- Strong proficiency in at least one backend language (Node.js, Python, Java, Go)
- Experience with SQL and NoSQL databases and a major cloud platform

Nice to Have:
- Kubernetes and Docker, CI/CD pipelines, open source contributions`;

// Sample HR answers by topic; each AI question is answered with the topic it matches
const SAMPLE_ANSWERS = [
  [/deal|disqualif|red flag|constraint|visa|location|availab|non-negotiable/i, 'No visa sponsorship; must be in San Francisco 3 days a week; must have run production systems at 1M+ requests/day.'],
  [/team|culture|style|mentor|lead|collaborat|autonom/i, 'Small startup team of 8. About 70% hands-on coding, 30% mentoring. Autonomous people with a bias for action do well.'],
  [/skill|technical|stack|language|proficien|experience|database|cloud/i, 'Must-haves: 5+ years backend, strong Node.js or Python, AWS (Lambda, RDS), system design for high traffic. Kubernetes is nice to have.'],
  [/context|90|urgen|why|deliver|priorit|launch|goal|scale/i, 'Critical for our Q2 payments launch: in the first 90 days they design the new payment gateway and start building it.']
];
const answerFor = (q) => (SAMPLE_ANSWERS.find(([re]) => re.test(`${q.title} ${q.question}`)) || [null, 'No strong preference beyond the job description.'])[1];

async function call(endpoint, init) {
  const res = await fetch(`${BASE}${endpoint}`, init);
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(`${endpoint}: ${[body.error, body.message].filter(Boolean).join(': ')}`);
  return body.data;
}
const post = (endpoint, json) => call(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });

async function run() {
  console.log(`\n🧪 SmartHire local test against ${BASE}\n${'='.repeat(60)}`);
  if (!process.env.GEMINI_API_KEY) {
    console.log('❌ GEMINI_API_KEY is missing from .env');
    process.exit(1);
  }

  // 1. Read resumes
  const pdfs = fs.existsSync(RESUMES_DIR) ? fs.readdirSync(RESUMES_DIR).filter(f => /\.pdf$/i.test(f)) : [];
  if (pdfs.length === 0) {
    console.log(`❌ No PDFs found in ${RESUMES_DIR}`);
    process.exit(1);
  }
  console.log(`\n📤 STEP 1: Reading ${pdfs.length} resume(s)`);
  const resumes = [];
  for (let i = 0; i < pdfs.length; i += 3) {
    const form = new FormData();
    for (const name of pdfs.slice(i, i + 3)) {
      form.append('resume_pdf', new Blob([fs.readFileSync(path.join(RESUMES_DIR, name))], { type: 'application/pdf' }), name);
    }
    const data = await call('/upload-resume', { method: 'POST', body: form });
    for (const file of data.files) {
      console.log(`   ${file.status === 'ok' ? '✅' : '⚠️ '} ${file.filename}${file.status === 'ok' ? ` (${file.resumeLength} chars)` : `: ${file.error}`}`);
      if (file.status === 'ok') resumes.push({ id: file.id, filename: file.filename, resume: file.resume });
    }
  }

  // 2. Questions
  console.log('\n❓ STEP 2: Generating clarifying questions');
  const { questions } = await post('/generate-questions', { jd: JD });
  questions.forEach((q, i) => console.log(`   ${i + 1}. ${q.title}\n      ${q.question}`));
  const answers = questions.map(q => ({ question: q.question, answer: answerFor(q) }));

  // 3. Score in batches
  console.log(`\n🎯 STEP 3: Scoring ${resumes.length} resume(s)`);
  const results = [];
  for (let i = 0; i < resumes.length; i += SCORE_BATCH) {
    const data = await post('/score-resumes', { jd: JD, answers, resumes: resumes.slice(i, i + SCORE_BATCH) });
    results.push(...data.results);
    console.log(`   ...${results.length}/${resumes.length} scored`);
  }
  results.sort((a, b) => b.score - a.score);
  console.log('\n🏆 RANKING:');
  results.forEach((r, i) => console.log(`   ${i + 1}. ${r.candidate_name || 'Unknown'} (${r.filename}) - ${r.score} - ${r.recommendation}`));

  // 4. Save, when configured
  const env = (await (await fetch(`${BASE}/health`)).json()).env_check || {};
  if (env.sheets_configured || env.gmail_configured) {
    console.log('\n💾 STEP 4: Saving results');
    const saved = await post('/save-results', { role: ROLE, jd: JD, answers, results });
    console.log(`   Sheet: ${saved.sheet_url || 'not configured'}\n   Email sent: ${saved.email_sent}`);
  } else {
    console.log('\n💾 STEP 4: Skipped (Google Sheets and email are not configured)');
  }

  console.log(`\n${'='.repeat(60)}\n✅ Done\n`);
}

if (require.main === module) {
  run().catch(error => {
    console.error(`\n❌ ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { run };
