const nodemailer = require('nodemailer');

// results: ranked list of { rank, candidate_name, filename, score, recommendation }.
// sheetUrl: link to the saved results tab, if they were saved.
async function sendResultsEmail(results, role, sheetUrl) {
  // Skip email if credentials not configured
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD ||
      process.env.GMAIL_USER === 'your_email@gmail.com') {
    console.log('Email credentials not configured, skipping email notification');
    return false;
  }

  const totalCandidates = results.length;
  const strongYes = results.filter(r => r.recommendation === 'Strong Yes').length;
  const yes = results.filter(r => r.recommendation === 'Yes').length;
  const maybe = results.filter(r => r.recommendation === 'Maybe').length;
  const no = results.filter(r => r.recommendation === 'No').length;
  const failed = results.filter(r => r.recommendation === 'Error').length;

  // results arrive sorted by rank
  const topCandidates = results.slice(0, 5).map(r =>
    `  ${r.rank}. ${r.candidate_name || 'Unknown'}${r.filename ? ` (${r.filename})` : ''}: ${r.score}/100, ${r.recommendation}`
  ).join('\n');


  const emailBody = `Hi HR Team,

Resume screening has completed successfully for role: ${role}

📊 SUMMARY:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Candidates: ${totalCandidates}

Recommendations:
  ✅ Strong Yes: ${strongYes}
  ✓  Yes: ${yes}
  ⚠️  Maybe: ${maybe}
  ❌ No: ${no}${failed ? `
  ⛔ Could not be scored: ${failed}` : ''}

🏆 TOP CANDIDATES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${topCandidates}

📋 NEXT STEPS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${sheetUrl ? `Full results (score, strengths, gaps and reasoning for every candidate):
   ${sheetUrl}

` : ''}Select candidates for interviews based on:
   • High scores (80+)
   • "Strong Yes" or "Yes" recommendations
   • "High" interview priority

All candidates are ranked by score - check the top 5 first!

---
🤖 Powered by Resume Screener AI
Generated at: ${new Date().toLocaleString()}
`;

  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: process.env.HR_EMAIL,
    subject: `✅ Resume Screening Complete - ${totalCandidates} Candidates Analyzed (${role})`,
    text: emailBody,
  };

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail(mailOptions);
    console.log('Email sent successfully');
    return true;
  } catch (error) {
    console.error('Email sending error:', error);
    // Don't throw - email is optional
    return false;
  }
}

module.exports = { sendResultsEmail };
