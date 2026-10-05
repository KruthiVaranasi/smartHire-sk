/**
 * Local Development Server
 * Runs the API endpoints and serves the web app in public/, like Vercel does
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config();

// Import API handlers
const uploadResume = require('./api/upload-resume');
const generateQuestions = require('./api/generate-questions');
const scoreResumes = require('./api/score-resumes');
const saveResults = require('./api/save-results');
const health = require('./api/health');
const login = require('./api/login');

const PORT = 3000;

// Route mapping
const routes = {
  '/api/upload-resume': uploadResume,
  '/api/generate-questions': generateQuestions,
  '/api/score-resumes': scoreResumes,
  '/api/save-results': saveResults,
  '/api/health': health,
  '/api/login': login
};

// Static files for the web app
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json'
};

// Serves /, /app (as app.html) and files under public/; false if nothing matched
function serveStatic(pathname, res) {
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith('/')) relative += 'index.html';
  if (!path.extname(relative)) relative += '.html';

  const file = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return false;
  }

  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
  return true;
}

// Add Express-like methods to response object
function addExpressMethods(res) {
  res.status = function(code) {
    this.statusCode = code;
    return this;
  };

  res.json = function(data) {
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(data));
    return this;
  };

  return res;
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  // Add Express-like methods to response
  addExpressMethods(res);

  // Find matching route
  const handler = routes[pathname];

  if (!handler) {
    if (req.method === 'GET' && !pathname.startsWith('/api/') && serveStatic(pathname, res)) return;
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Report handler crashes as 500s (not "Invalid JSON"), unless a response already went out
  const runHandler = async () => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error('Unhandled handler error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error', message: error.message });
      }
    }
  };

  // Parse request body for POST requests
  if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        req.body = JSON.parse(body);
      } catch (error) {
        console.error('Error parsing JSON:', error);
        res.status(400).json({ error: 'Invalid JSON' });
        return;
      }
      await runHandler();
    });
  } else {
    // For multipart/form-data or GET requests, call handler directly
    await runHandler();
  }
});

server.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 Local Development Server Started');
  console.log('='.repeat(70));
  console.log(`\n✅ Server running at: http://localhost:${PORT}`);
  console.log(`   Web app:   http://localhost:${PORT}/  (workspace: http://localhost:${PORT}/app)`);
  console.log('\n📋 Available endpoints:');
  console.log('   - POST http://localhost:3000/api/upload-resume');
  console.log('   - POST http://localhost:3000/api/generate-questions');
  console.log('   - POST http://localhost:3000/api/score-resumes');
  console.log('   - POST http://localhost:3000/api/save-results');
  console.log('   - POST http://localhost:3000/api/login');
  console.log('   - GET  http://localhost:3000/api/health');
  console.log('\n💡 To test the API, run in another terminal:');
  console.log('   npm test');
  console.log('\n' + '='.repeat(70) + '\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
