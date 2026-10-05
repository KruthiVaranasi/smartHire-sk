// SmartHire workspace: sign-in, upload, clarifying questions, screening and results.
// Talks to the API on the same origin (/api/...). State is kept in sessionStorage so a
// page refresh doesn't lose the role, the questions or the results.

(() => {
  const API = '/api';
  const BATCH_SIZE = 3;            // PDFs per upload request (stays well under Vercel's 4.5 MB body limit)
  const MAX_SCREENING_CALLS = 40;  // safety stop for the screening loop
  const REQUEST_TIMEOUT_MS = 75000;
  const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  const STATE_KEY = 'smarthire.state';
  const TOKEN_KEY = 'smarthire.token';

  const $ = (id) => document.getElementById(id);

  // ---------- Storage (wrapped: private windows can block it) ----------

  const store = {
    get(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
    remove(key) { try { sessionStorage.removeItem(key); } catch { /* ignore */ } }
  };

  const freshState = () => ({
    step: 1,
    role: '',
    jd: '',
    uploads: [],        // [{ name, size, status: 'ok' | 'failed', error }]
    questions: null,    // [{ title, question }]
    answers: [],        // strings, same order as questions
    results: null       // last finished screening response data
  });

  let state = Object.assign(freshState(), store.get(STATE_KEY) || {});
  let token = store.get(TOKEN_KEY);
  let queue = [];       // files picked but not uploaded yet: { id, file, name, size, status, error }
  let busy = false;
  let passwordRequired = false;

  const save = () => store.set(STATE_KEY, state);

  // ---------- Helpers ----------

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const formatSize = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  function showError(el, message) {
    el.innerHTML = `<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" stroke="currentColor" stroke-width="1.5"/><path d="M9 5.2v4.6M9 12.4v.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><span>${esc(message)}</span>`;
    el.hidden = false;
  }
  const hideError = (el) => { el.hidden = true; };

  class AuthRequired extends Error {}

  async function api(path, { method = 'POST', json, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;

    let res;
    try {
      res = await fetch(`${API}${path}`, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(error.name === 'TimeoutError'
        ? 'The server took too long to respond. Please try again.'
        : 'Could not reach the server. Check your connection and try again.');
    }

    let data;
    try { data = await res.json(); } catch { data = { error: `Unexpected response from server (HTTP ${res.status})` }; }

    if (res.status === 401 && data.auth === 'password') {
      token = null;
      store.remove(TOKEN_KEY);
      showGate();
      throw new AuthRequired('Your session has ended. Please sign in again.');
    }
    if (!res.ok) {
      const error = new Error([data.error, data.message].filter(Boolean).join(': ') || `Request failed (HTTP ${res.status})`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  // ---------- Sign-in ----------

  function showGate() {
    $('gate').hidden = false;
    $('workspace').hidden = true;
    $('new-screening').hidden = true;
    $('sign-out').hidden = true;
    setTimeout(() => $('password').focus(), 50);
  }

  function showWorkspace() {
    $('gate').hidden = true;
    $('workspace').hidden = false;
    $('sign-out').hidden = !passwordRequired;
    render();
  }

  $('gate-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError($('gate-error'));
    $('gate-submit').disabled = true;
    try {
      const data = await api('/login', { json: { password: $('password').value } });
      token = data.token;
      if (token) store.set(TOKEN_KEY, token);
      $('password').value = '';
      showWorkspace();
    } catch (error) {
      if (!(error instanceof AuthRequired)) showError($('gate-error'), error.message);
    } finally {
      $('gate-submit').disabled = false;
    }
  });

  $('sign-out').addEventListener('click', () => {
    token = null;
    store.remove(TOKEN_KEY);
    showGate();
  });

  // ---------- Navigation ----------

  function goTo(step) {
    state.step = step;
    save();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function render() {
    const uploadedOk = state.uploads.filter(u => u.status === 'ok').length;

    document.querySelectorAll('.stepper li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('active', n === state.step);
      li.classList.toggle('done', n < state.step || (n === 3 && state.results && state.step !== 3));
    });
    [1, 2, 3].forEach((n) => { $(`step-${n}`).hidden = n !== state.step; });

    $('role-pill').classList.toggle('show', Boolean(state.role && uploadedOk));
    $('role-pill-name').textContent = state.role;
    $('new-screening').hidden = !(uploadedOk || queue.length || state.role);

    if (state.step === 1) renderStep1();
    if (state.step === 2) renderStep2();
    if (state.step === 3) renderStep3();
  }

  function newScreening() {
    if (busy) return;
    const hasWork = state.uploads.length || queue.length || state.questions;
    if (hasWork && !confirm('Start a new screening? The current results stay in your Google Sheet.')) return;
    state = freshState();
    queue = [];
    save();
    $('role').value = '';
    $('jd').value = '';
    goTo(1);
  }
  $('new-screening').addEventListener('click', newScreening);
  $('new-screening-2').addEventListener('click', newScreening);

  // ---------- Step 1: role and resumes ----------

  $('role').addEventListener('input', () => { state.role = $('role').value; save(); renderStep1(); });
  $('jd').addEventListener('input', () => { state.jd = $('jd').value; save(); renderStep1(); });

  function renderStep1() {
    const locked = state.uploads.some(u => u.status === 'ok');
    // Only write when different, so typing in the middle doesn't move the cursor
    if ($('role').value !== state.role) $('role').value = state.role;
    if ($('jd').value !== state.jd) $('jd').value = state.jd;
    // Once resumes are stored under this role and JD, changing them would split the data
    $('role').disabled = locked;
    $('jd').disabled = locked;

    const items = [
      ...state.uploads.map(u => ({ ...u, done: true })),
      ...queue
    ];
    $('file-list').innerHTML = items.map(item => `
      <li class="file-item">
        <span class="file-icon">PDF</span>
        <div style="min-width:0">
          <div class="file-name" title="${esc(item.name)}">${esc(item.name)}</div>
          ${item.error ? `<div class="file-error">${esc(item.error)}</div>` : ''}
        </div>
        <span class="file-size">${item.size ? formatSize(item.size) : ''}</span>
        ${item.done
          ? `<span class="file-status ${item.status}">${item.status === 'ok' ? 'Uploaded' : 'Failed'}</span>`
          : item.status === 'uploading'
            ? '<span class="file-status uploading">Uploading…</span>'
            : `<button class="icon-btn" type="button" data-remove="${item.id}" aria-label="Remove ${esc(item.name)}"><svg viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>`}
      </li>`).join('');

    const ok = state.uploads.filter(u => u.status === 'ok').length;
    const failed = state.uploads.filter(u => u.status === 'failed').length;
    const waiting = queue.filter(q => q.status === 'queued').length;
    $('upload-summary').textContent = ok || failed || waiting
      ? [ok && `${ok} uploaded`, failed && `${failed} failed`, waiting && `${waiting} ready to upload`].filter(Boolean).join(' · ')
      : 'No resumes uploaded yet.';

    $('upload-btn').disabled = busy || waiting === 0;
    $('upload-btn').textContent = busy ? 'Uploading…' : waiting ? `Upload ${waiting} resume${waiting === 1 ? '' : 's'}` : 'Upload resumes';
    $('to-step-2').disabled = busy || ok === 0;
  }

  $('file-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    queue = queue.filter(q => q.id !== button.dataset.remove);
    renderStep1();
  });

  // Drag and drop
  const dropzone = $('dropzone');
  ['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.remove('dragging'); }));
  dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  $('file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  let jszipLoading;
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    jszipLoading = jszipLoading || new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = JSZIP_URL;
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => { jszipLoading = null; reject(new Error('Could not load the zip reader. Check your connection, or upload the PDFs directly.')); };
      document.head.appendChild(script);
    });
    return jszipLoading;
  }

  // Zips are unpacked in the browser, so any size works and each PDF is tracked separately
  async function addFiles(fileList) {
    hideError($('step1-error'));
    const skipped = [];
    // Skip files already queued or uploaded; a failed file can be added again
    const known = new Set([...queue, ...state.uploads.filter(u => u.status === 'ok')].map(f => `${f.name}|${f.size}`));

    const enqueue = (file, name) => {
      const key = `${name}|${file.size}`;
      if (known.has(key)) return;
      known.add(key);
      queue.push({ id: Math.random().toString(36).slice(2), file, name, size: file.size, status: 'queued' });
    };

    for (const file of Array.from(fileList)) {
      if (/\.pdf$/i.test(file.name)) {
        enqueue(file, file.name);
      } else if (/\.zip$/i.test(file.name)) {
        try {
          const JSZip = await loadJSZip();
          const zip = await JSZip.loadAsync(await file.arrayBuffer());
          const entries = Object.values(zip.files).filter(entry => {
            const base = entry.name.split('/').pop();
            return !entry.dir && /\.pdf$/i.test(base) && !entry.name.startsWith('__MACOSX/') && !base.startsWith('.');
          });
          if (entries.length === 0) skipped.push(`${file.name} has no PDFs inside`);
          for (const entry of entries) {
            const bytes = await entry.async('arraybuffer');
            const name = entry.name.split('/').pop();
            enqueue(new File([bytes], name, { type: 'application/pdf' }), name);
          }
        } catch (error) {
          skipped.push(`${file.name}: ${error.message.includes('zip reader') ? error.message : 'not a readable zip file'}`);
        }
      } else {
        skipped.push(`${file.name} is not a PDF or zip`);
      }
    }

    if (skipped.length) showError($('step1-error'), `Skipped: ${skipped.join('; ')}.`);
    renderStep1();
  }

  $('upload-btn').addEventListener('click', uploadQueued);

  async function uploadQueued() {
    hideError($('step1-error'));
    state.role = $('role').value.trim();
    state.jd = $('jd').value.trim();
    $('role').classList.toggle('invalid', !state.role);
    $('jd').classList.toggle('invalid', state.jd.length < 30);
    if (!state.role || state.jd.length < 30) {
      showError($('step1-error'), !state.role ? 'Add a role title first.' : 'Paste the full job description (at least a few sentences).');
      return;
    }
    save();

    busy = true;
    const pending = queue.filter(q => q.status === 'queued');
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      batch.forEach(item => { item.status = 'uploading'; });
      renderStep1();

      const form = new FormData();
      form.append('jd', state.jd);
      form.append('role', state.role);
      batch.forEach(item => form.append('resume_pdf', item.file, item.name));

      let report = null;
      let batchError = null;
      try {
        const data = await api('/upload-resume', { form });
        report = data.data.files;
      } catch (error) {
        if (error instanceof AuthRequired) { batch.forEach(item => { item.status = 'queued'; }); busy = false; return; }
        report = error.data && error.data.files;   // 400 "none readable" still has a per-file report
        batchError = error.message;
      }

      // The server reports files in the order they were sent
      batch.forEach((item, index) => {
        const result = report && report[index];
        state.uploads.push({
          name: item.name,
          size: item.size,
          status: result ? result.status : 'failed',
          error: result ? (result.error || '') : batchError
        });
      });
      queue = queue.filter(q => !batch.includes(q));
      save();
      renderStep1();
    }
    busy = false;
    render();
  }

  $('to-step-2').addEventListener('click', () => goTo(2));

  // ---------- Step 2: clarifying questions ----------

  let generating = false;
  let generationFailed = false;   // stops automatic retries; the user retries with the button

  // Requests only start on their own while the workspace is showing; behind the
  // sign-in screen a 401 would otherwise trigger the same request again and again
  const workspaceVisible = () => !$('workspace').hidden;

  function renderStep2() {
    if (!state.questions && !generating && !generationFailed && workspaceVisible()) generateQuestions();
    $('questions-loading').hidden = !generating;
    $('regenerate').hidden = generating || (!state.questions && !generationFailed);
    $('regenerate').textContent = state.questions ? 'New questions' : 'Try again';

    const list = $('questions');
    if (!state.questions) { list.innerHTML = ''; updateAnswerState(); return; }

    // Build once per question set; keep focus and typing intact afterwards
    if (list.dataset.for !== JSON.stringify(state.questions)) {
      list.dataset.for = JSON.stringify(state.questions);
      list.innerHTML = state.questions.map((q, i) => `
        <div class="question" data-index="${i}">
          <div class="question-head">
            <span class="question-num">${i + 1}</span>
            <span class="question-title">${esc(q.title)}</span>
          </div>
          <p class="question-text">${esc(q.question)}</p>
          <label class="sr-only" for="answer-${i}">Answer to question ${i + 1}</label>
          <textarea class="textarea" id="answer-${i}" data-index="${i}" placeholder="Your answer…">${esc(state.answers[i] || '')}</textarea>
        </div>`).join('');
    }
    updateAnswerState();
  }

  function updateAnswerState() {
    const questions = state.questions || [];
    let answered = 0;
    questions.forEach((_, i) => {
      const filled = Boolean((state.answers[i] || '').trim());
      if (filled) answered++;
      const card = document.querySelector(`.question[data-index="${i}"]`);
      if (card) card.classList.toggle('answered', filled);
    });
    $('answer-count').textContent = questions.length ? `${answered} of ${questions.length} answered` : '';
    $('start-screening').disabled = generating || !questions.length || answered < questions.length;
  }

  $('questions').addEventListener('input', (event) => {
    const index = event.target.dataset.index;
    if (index === undefined) return;
    state.answers[Number(index)] = event.target.value;
    event.target.classList.remove('invalid');
    save();
    updateAnswerState();
  });

  async function generateQuestions() {
    generating = true;
    generationFailed = false;
    hideError($('step2-error'));
    renderStep2();
    try {
      const data = await api('/generate-questions', { json: { role: state.role } });
      state.questions = data.data.questions;
      state.answers = state.questions.map(() => '');
      state.results = null;
      save();
    } catch (error) {
      generationFailed = !(error instanceof AuthRequired);   // after sign-in, generate again automatically
      if (generationFailed) {
        showError($('step2-error'), error.status === 404 ? 'No resumes were found for this role. Go back and upload some first.' : error.message);
      }
    } finally {
      generating = false;
      renderStep2();
    }
  }

  $('regenerate').addEventListener('click', () => {
    if (state.questions && state.answers.some(a => (a || '').trim()) &&
        !confirm('Replace these questions with a new set? Your current answers will be cleared.')) return;
    state.questions = null;
    save();
    generateQuestions();
  });

  $('back-to-1').addEventListener('click', () => goTo(1));

  $('start-screening').addEventListener('click', () => {
    goTo(3);
    runScreening({ force: false });
  });

  // ---------- Step 3: screening and results ----------

  let screening = false;

  function answersPayload() {
    return state.questions.map((q, i) => ({ question: q.question, answer: (state.answers[i] || '').trim() }));
  }

  function renderStep3() {
    const showResults = Boolean(state.results) && !screening;
    $('results-view').hidden = !showResults;
    $('progress-view').hidden = showResults;
    if (showResults) renderResults(state.results);
    else if (!screening && workspaceVisible()) runScreening({ force: false });   // e.g. after a refresh mid-run
  }

  function setProgress(total, remaining) {
    const bar = $('progress');
    if (!total) {
      bar.classList.add('indeterminate');
      $('progress-count').textContent = 'Starting…';
      return;
    }
    const done = total - remaining;
    bar.classList.remove('indeterminate');
    $('progress-bar').style.width = `${Math.round((done / total) * 100)}%`;
    $('progress-count').textContent = `${done} of ${total} resumes scored`;
  }

  async function runScreening({ force }) {
    if (screening) return;
    if (!state.questions) { goTo(2); return; }
    screening = true;
    state.results = null;
    save();
    hideError($('step3-error'));
    $('retry-screening').hidden = true;
    $('progress-back').hidden = true;
    $('results-view').hidden = true;
    $('progress-view').hidden = false;
    setProgress(0, 0);

    try {
      for (let call = 1; call <= MAX_SCREENING_CALLS; call++) {
        const data = (await api('/submit-screening', {
          json: { role: state.role, answers: answersPayload(), force: force && call === 1 }
        })).data;
        setProgress(data.total_candidates, data.remaining);
        if (data.done) {
          state.results = data;
          save();
          break;
        }
      }
      if (!state.results) throw new Error('Screening is taking longer than expected. Press Retry to continue where it stopped.');
    } catch (error) {
      if (error instanceof AuthRequired) { screening = false; return; }
      showError($('step3-error'), error.status === 400 && error.data && error.data.missing_answers
        ? `Some answers are missing (question ${error.data.missing_answers.join(', ')}). Go back and fill them in.`
        : error.message);
      $('retry-screening').hidden = false;
      $('progress-back').hidden = false;
    } finally {
      screening = false;
    }
    if (state.results) render();
  }

  $('retry-screening').addEventListener('click', () => runScreening({ force: false }));

  $('rerun').addEventListener('click', () => {
    if (!confirm('Score every resume again with the current answers?')) return;
    runScreening({ force: true });
  });

  $('edit-answers').addEventListener('click', () => goTo(2));
  $('progress-back').addEventListener('click', () => goTo(2));

  const BADGE = { 'Strong Yes': 'strong-yes', 'Yes': 'yes', 'Maybe': 'maybe', 'No': 'no' };

  function renderResults(data) {
    const s = data.summary;
    const total = data.total_candidates;
    $('results-intro').textContent =
      `${total} candidate${total === 1 ? '' : 's'} for ${state.role}, scored against the job description and your ${state.questions ? state.questions.length : ''} answers.` +
      (data.email_sent ? ' A summary was emailed to HR.' : '');

    $('summary').innerHTML = `
      <div class="summary-card total"><div class="n">${total}</div><div class="k">Screened</div></div>
      ${[['Strong Yes', s.strong_yes], ['Yes', s.yes], ['Maybe', s.maybe], ['No', s.no]].map(([label, n]) => `
        <div class="summary-card"><div class="n">${n}</div><div class="k"><span class="badge ${BADGE[label]}">${label}</span></div></div>`).join('')}`;

    const candidates = data.candidates || data.top_5 || [];
    $('candidates').innerHTML = candidates.map((c, i) => {
      const badge = BADGE[c.recommendation] || 'error';
      const name = c.candidate_name && c.candidate_name !== 'Unknown' ? c.candidate_name : (c.filename || 'Unknown candidate');
      const list = (items, sign) => (items && items.length)
        ? `<ul>${items.map(t => `<li><span class="sign ${sign === '+' ? 'plus' : 'minus'}">${sign === '+' ? '+' : '−'}</span><span>${esc(t)}</span></li>`).join('')}</ul>`
        : '<p style="color:var(--muted);font-size:14px">None noted.</p>';
      return `
        <li class="candidate ${c.rank <= 3 ? 'top' : ''}">
          <button class="candidate-row" type="button" aria-expanded="false" aria-controls="detail-${i}">
            <span class="candidate-rank">${c.rank}</span>
            <span style="min-width:0">
              <span class="candidate-name" style="display:block">${esc(name)}</span>
              <span class="candidate-file" style="display:block">${esc(c.filename || '')}</span>
            </span>
            <span class="score"><b>${Number(c.score) || 0}</b><span class="score-bar"><span style="width:${Math.max(0, Math.min(100, Number(c.score) || 0))}%"></span></span></span>
            <span class="badge ${badge}">${esc(c.recommendation === 'Error' ? 'Not scored' : c.recommendation)}</span>
            <svg class="chev" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M5 7l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="candidate-detail" id="detail-${i}">
            ${c.strengths || c.gaps ? `
            <div class="detail-grid">
              <div><h4>Strengths</h4>${list(c.strengths, '+')}</div>
              <div><h4>Gaps &amp; concerns</h4>${list(c.gaps, '−')}</div>
            </div>` : ''}
            ${c.justification ? `<div class="justification"><h4>Why this score</h4>${esc(c.justification)}</div>` : ''}
            ${c.interview_priority ? `<p class="priority">Interview priority: <b>${esc(c.interview_priority)}</b></p>` : ''}
          </div>
        </li>`;
    }).join('');

    if (s.failed) {
      $('results-intro').textContent += ` ${s.failed} resume${s.failed === 1 ? '' : 's'} could not be scored and ${s.failed === 1 ? 'is' : 'are'} listed as "Not scored"; Re-run screening to try again.`;
    }
  }

  $('candidates').addEventListener('click', (event) => {
    const row = event.target.closest('.candidate-row');
    if (!row) return;
    const item = row.parentElement;
    const open = !item.classList.contains('open');
    item.classList.toggle('open', open);
    row.setAttribute('aria-expanded', String(open));
  });

  // ---------- Start ----------

  async function init() {
    try {
      const res = await fetch(`${API}/health`);
      const health = await res.json();
      passwordRequired = Boolean(health.env_check && health.env_check.password_required);
    } catch {
      passwordRequired = false;   // the first real request will tell us if sign-in is needed
    }
    if (passwordRequired && !token) showGate();
    else showWorkspace();
  }

  init();
})();
