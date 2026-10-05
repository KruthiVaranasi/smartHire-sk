/**
 * Local Testing Script for Resume Screener
 *
 * This script tests all 3 steps of the workflow:
 * 1. Upload 3 resumes
 * 2. Generate clarifying questions
 * 3. Submit screening with HR answers
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const http = require('http');

// Load environment variables
require('dotenv').config();

// Test configuration
const TEST_CONFIG = {
  role: 'SDE',
  jd: `We are seeking a Senior Software Development Engineer with 5+ years of experience in building scalable backend systems.

Key Responsibilities:
- Design and implement microservices using Node.js, Python, or Java
- Build RESTful APIs and integrate with cloud services (AWS/GCP/Azure)
- Optimize database queries and system performance
- Mentor junior engineers and lead technical discussions
- Participate in code reviews and architectural decisions

Required Skills:
- 5+ years of software development experience
- Strong proficiency in at least one backend language (Node.js, Python, Java, Go)
- Experience with SQL and NoSQL databases
- Understanding of system design and distributed systems
- Experience with cloud platforms (AWS, GCP, or Azure)
- Strong problem-solving and communication skills

Nice to Have:
- Experience with Kubernetes and Docker
- Knowledge of machine learning or data engineering
- Open source contributions
- Experience with CI/CD pipelines`,

  // Every PDF in RESUMES_DIR (default: ../samples next to this repo)
  resumes: (() => {
    const dir = process.env.RESUMES_DIR || path.join(__dirname, '..', 'samples');
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => /\.pdf$/i.test(f)).map(f => path.join(dir, f))
      : [];
  })(),

  // Sample HR answers by topic. The AI picks its own questions, so each question is
  // answered with the topic it matches (see answerFor below).
  hrAnswers: {
    answer1: 'This role is critical for our Q2 product launch. The person will lead the backend architecture for our new payment processing system, working with a team of 8 engineers. First 90 days will focus on understanding our existing microservices, designing the new payment gateway, and starting implementation.',
    answer2: 'Absolute must-haves: (1) 5+ years backend experience with production systems, (2) Strong Node.js or Python skills, (3) Experience with AWS services especially Lambda and RDS, (4) System design experience for high-traffic applications. Nice-to-haves: Kubernetes, payment systems experience, team leadership.',
    answer3: 'This is a fast-paced startup environment with a small team of 8 engineers. Candidates who thrive here are autonomous, comfortable with ambiguity, strong communicators, and have a bias for action. Past successful hires came from startups or had entrepreneurial experience. We value ownership and end-to-end thinking.',
    answer4: 'Deal-breakers: (1) No visa sponsorship available - must be authorized to work in US, (2) Must be available for full-time in-person work in San Francisco 3 days/week, (3) Cannot have non-compete agreements with payment companies, (4) Must have experience with production systems at scale (1M+ requests/day).'
  }
};

// Test functions
async function testStep1_UploadResumes() {
  console.log('\n📤 STEP 1: Uploading Resumes\n' + '='.repeat(50));

  const uploadEndpoint = '/api/upload-resume';

  for (let i = 0; i < TEST_CONFIG.resumes.length; i++) {
    const resumePath = TEST_CONFIG.resumes[i];
    const resumeNumber = i + 1;

    console.log(`\n[${resumeNumber}/${TEST_CONFIG.resumes.length}] Uploading: ${path.basename(resumePath)}`);

    try {
      // Check if file exists
      if (!fs.existsSync(resumePath)) {
        console.log(`❌ File not found: ${resumePath}`);
        continue;
      }

      // Create form data
      const form = new FormData();
      form.append('resume_pdf', fs.createReadStream(resumePath));
      form.append('jd', TEST_CONFIG.jd);
      form.append('role', TEST_CONFIG.role);

      // Make request
      const response = await makeRequest('POST', uploadEndpoint, form);

      if (response.success) {
        console.log(`✅ Success: ${response.message}`);
        console.log(`   - Filename: ${response.data.filename}`);
        console.log(`   - Role: ${response.data.role}`);
        console.log(`   - Resume Length: ${response.data.resumeLength} characters`);
        console.log(`   - Uploaded At: ${response.data.uploadedAt}`);
      } else {
        console.log(`❌ Failed: ${response.error || 'Unknown error'}`);
      }

      // Wait 2 seconds between uploads
      if (i < TEST_CONFIG.resumes.length - 1) {
        await sleep(2000);
      }

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  console.log('\n✅ Step 1 Complete: All resumes uploaded to Google Sheets\n');
}

async function testStep2_GenerateQuestions() {
  console.log('\n❓ STEP 2: Generating Clarifying Questions\n' + '='.repeat(50));

  try {
    const response = await makeRequest('POST', '/api/generate-questions', {
      role: TEST_CONFIG.role
    });

    if (response.success) {
      console.log(`✅ Success: ${response.message}`);
      console.log(`   - Role: ${response.data.role}`);
      console.log(`   - Total Resumes: ${response.data.total_resumes}`);
      console.log(`\n📋 Generated Questions:\n`);

      response.data.questions.forEach((q, index) => {
        console.log(`${index + 1}. ${q.title}`);
        console.log(`   ${q.question}\n`);
      });

      console.log(`\n✅ Step 2 Complete: Questions added to all rows in Google Sheets\n`);
      return response.data.questions;
    } else {
      console.log(`❌ Failed: ${response.error || 'Unknown error'}`);
      return null;
    }

  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    return null;
  }
}

// Pick the sample answer whose topic matches the question
function answerFor(question) {
  const text = `${question.title} ${question.question}`.toLowerCase();
  const { answer1, answer2, answer3, answer4 } = TEST_CONFIG.hrAnswers;
  if (/deal|disqualif|red flag|constraint|visa|location|availab|non-negotiable/.test(text)) return answer4;
  if (/team|culture|style|mentor|collaborat|autonom/.test(text)) return answer3;
  if (/skill|technical|stack|language|proficien|experience/.test(text)) return answer2;
  if (/context|90|urgen|why|deliver|priorit|launch|goal/.test(text)) return answer1;
  return `No specific preference beyond the job description. Overall context: ${answer1}`;
}

async function testStep3_SubmitScreening(questions) {
  console.log('\n🎯 STEP 3: Submitting Screening\n' + '='.repeat(50));

  if (!questions || questions.length === 0) {
    console.log('❌ Skipped: no questions from step 2 to answer');
    return;
  }

  const answers = questions.map(q => ({ question: q.question, answer: answerFor(q) }));
  console.log('\nHR Answers:');
  answers.forEach((qa, i) => {
    console.log(`\n${i + 1}. ${questions[i].title}: ${qa.answer.substring(0, 80)}...`);
  });

  try {
    // Scoring is chunked: repeat the call until the server reports nothing remaining.
    // force is sent on the first call only, so each test run re-scores from scratch.
    let response;
    for (let call = 1; ; call++) {
      response = await makeRequest('POST', '/api/submit-screening', {
        answers,
        role: TEST_CONFIG.role,
        force: call === 1
      });
      if (!response.success || response.data.done) break;
      console.log(`   ...call ${call}: scored ${response.data.scored_this_call}, ${response.data.remaining} remaining`);
    }

    if (response.success) {
      console.log(`\n✅ Success: ${response.message}`);
      console.log(`\n📊 SUMMARY:`);
      console.log(`   - Total Candidates: ${response.data.total_candidates}`);
      console.log(`   - Strong Yes: ${response.data.summary.strong_yes}`);
      console.log(`   - Yes: ${response.data.summary.yes}`);
      console.log(`   - Maybe: ${response.data.summary.maybe}`);
      console.log(`   - No: ${response.data.summary.no}`);
      console.log(`   - Failed to score: ${response.data.summary.failed}`);

      console.log(`\n🏆 TOP 5 CANDIDATES:`);
      response.data.top_5.forEach((candidate) => {
        console.log(`   ${candidate.rank}. ${candidate.candidate_name || 'Unknown'} (${candidate.filename || 'no filename'}) - Score: ${candidate.score} - ${candidate.recommendation}`);
      });

      console.log(`\n✅ Step 3 Complete: All results updated in Google Sheets (email sent: ${response.data.email_sent})\n`);
    } else {
      console.log(`❌ Failed: ${response.error || 'Unknown error'}`);
    }

  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

// Helper: Make HTTP request to local Vercel dev server
async function makeRequest(method, endpoint, data) {
  return new Promise((resolve, reject) => {
    const isFormData = data instanceof FormData;

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: endpoint,
      method: method,
      headers: isFormData ? data.getHeaders() : {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (error) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (isFormData) {
      data.pipe(req);
    } else {
      req.write(JSON.stringify(data));
      req.end();
    }
  });
}

// Helper: Sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main test runner
async function runTests() {
  console.log('\n' + '='.repeat(70));
  console.log('🧪 RESUME SCREENER - LOCAL TESTING');
  console.log('='.repeat(70));
  console.log('\nConfiguration:');
  console.log(`  - Role: ${TEST_CONFIG.role}`);
  console.log(`  - Resumes to test: ${TEST_CONFIG.resumes.length}`);
  console.log(`  - Google Sheet ID: ${process.env.GOOGLE_SHEET_ID}`);
  console.log(`  - HR Email: ${process.env.HR_EMAIL}`);
  console.log('\n' + '='.repeat(70));

  // Verify environment variables
  console.log('\n🔍 Checking Environment Variables...');
  const requiredVars = [
    'GEMINI_API_KEY',
    'GOOGLE_SHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'HR_EMAIL'
  ];

  let missingVars = [];
  for (const varName of requiredVars) {
    if (!process.env[varName] || process.env[varName].includes('your_') || process.env[varName].includes('Your ')) {
      missingVars.push(varName);
      console.log(`❌ ${varName}: Missing or not configured`);
    } else {
      console.log(`✅ ${varName}: Configured`);
    }
  }

  if (missingVars.length > 0) {
    console.log('\n❌ ERROR: Missing environment variables!');
    console.log('\nPlease update .env file with:');
    missingVars.forEach(varName => {
      console.log(`  - ${varName}`);
    });
    console.log('\nSee README.md for instructions on getting these credentials.\n');
    process.exit(1);
  }

  console.log('\n✅ All environment variables configured!\n');
  console.log('Make sure Vercel dev server is running: npm run dev\n');

  try {
    // Run all 3 steps
    await testStep1_UploadResumes();
    await sleep(2000);

    const questions = await testStep2_GenerateQuestions();
    await sleep(2000);

    await testStep3_SubmitScreening(questions);

    console.log('\n' + '='.repeat(70));
    console.log('✅ ALL TESTS COMPLETED SUCCESSFULLY!');
    console.log('='.repeat(70));
    console.log('\n📊 Check your results:');
    console.log(`   - Google Sheets: https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}/edit`);
    console.log(`   - Email: ${process.env.HR_EMAIL}\n`);

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

// Run tests
if (require.main === module) {
  runTests();
}

module.exports = { runTests };
