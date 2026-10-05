// SmartHire workspace: sign-in, upload, clarifying questions, scoring, results and export.
// The server stores nothing about a screening: the browser keeps the resumes' text,
// questions, answers and scores (in sessionStorage, so a refresh doesn't lose them)
// and sends what each step needs.

(() => {
  const API = '/api';
  const UPLOAD_BATCH = 3;          // PDFs per upload request (well under Vercel's 4.5 MB body limit)
  const SCORE_BATCH = 3;           // resumes per scoring request (finishes well inside 60s)
  const REQUEST_TIMEOUT_MS = 75000;
  const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  const STATE_KEY = 'smarthire.state';
  const TOKEN_KEY = 'smarthire.token';

  const $ = (id) => document.getElementById(id);

  // ---------- Storage (wrapped: private windows can block it, and it has a size limit) ----------

  const store = {
    get(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
    remove(key) { try { sessionStorage.removeItem(key); } catch { /* ignore */ } }
  };

  const freshState = () => ({
    step: 1,
    role: '',
    jd: '',
    resumes: [],        // [{ id, filename, size, text }]: resumes read successfully
    uploads: [],        // [{ name, size, status: 'ok' | 'duplicate' | 'failed', error, id }]: what HR sees
    questions: null,    // [{ title, question }]
    questionsJd: '',    // the JD the questions were written for
    answers: [],        // strings, same order as questions
    scores: { key: '', byId: {} },   // results for the current JD + answers, by resume id
    saved: null         // { sheet_url, tab, email_sent } after "Save results"
  });

  let state = Object.assign(freshState(), store.get(STATE_KEY) || {});
  let token = store.get(TOKEN_KEY);
  let queue = [];       // files picked but not read yet: { id, file, name, size, status }
  let busy = false;
  let config = { passwordRequired: false, sheets: false, email: false };

  const save = () => store.set(STATE_KEY, state);

  const STATUS_LABEL = { ok: 'Ready', duplicate: 'Already added', failed: 'Failed' };
  const BADGE = { 'Strong Yes': 'strong-yes', 'Yes': 'yes', 'Maybe': 'maybe', 'No': 'no' };

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
    $('sign-out').hidden = !config.passwordRequired;
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

  // Requests only start on their own while the workspace is showing; behind the
  // sign-in screen a 401 would otherwise trigger the same request again and again
  const workspaceVisible = () => !$('workspace').hidden;

  function goTo(step) {
    state.step = step;
    save();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function render() {
    document.querySelectorAll('.stepper li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('active', n === state.step);
      li.classList.toggle('done', n < state.step);
    });
    [1, 2, 3].forEach((n) => { $(`step-${n}`).hidden = n !== state.step; });

    $('role-pill').classList.toggle('show', Boolean(state.role && state.step > 1));
    $('role-pill-name').textContent = state.role;
    $('new-screening').hidden = !(state.resumes.length || queue.length || state.role || state.jd);

    if (state.step === 1) renderStep1();
    if (state.step === 2) renderStep2();
    if (state.step === 3) renderStep3();
  }

  function newScreening() {
    if (busy) return;
    const hasWork = state.resumes.length || queue.length || state.questions;
    if (hasWork && !confirm('Start a new screening? The current resumes, answers and results will be cleared from this browser.')) return;
    state = freshState();
    queue = [];
    save();
    $('role').value = '';
    $('jd').value = '';
    goTo(1);
  }
  $('new-screening').addEventListener('click', newScreening);
  $('new-screening-2').addEventListener('click', newScreening);

  // ---------- Step 1: role, JD and resumes ----------

  $('role').addEventListener('input', () => { state.role = $('role').value; save(); renderStep1(); });
  $('jd').addEventListener('input', () => { state.jd = $('jd').value; save(); renderStep1(); });

  function renderStep1() {
    // Only write when different, so typing in the middle doesn't move the cursor
    if ($('role').value !== state.role) $('role').value = state.role;
    if ($('jd').value !== state.jd) $('jd').value = state.jd;

    const items = [
      ...state.uploads.map(u => ({ ...u, done: true })),
      ...queue
    ];
    $('file-list').innerHTML = items.map((item, index) => `
      <li class="file-item">
        <span class="file-icon">PDF</span>
        <div style="min-width:0">
          <div class="file-name" title="${esc(item.name)}">${esc(item.name)}</div>
          ${item.error && item.status === 'failed' ? `<div class="file-error">${esc(item.error)}</div>` : ''}
        </div>
        <span class="file-size">${item.size ? formatSize(item.size) : ''}</span>
        ${item.status === 'uploading'
          ? '<span class="file-status uploading">Reading…</span>'
          : `<span style="display:flex;align-items:center;gap:6px">
               ${item.done ? `<span class="file-status ${item.status}">${STATUS_LABEL[item.status] || 'Failed'}</span>` : '<span class="file-status queued">Queued</span>'}
               <button class="icon-btn" type="button" ${item.done ? `data-remove-upload="${index}"` : `data-remove="${item.id}"`} aria-label="Remove ${esc(item.name)}"><svg viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
             </span>`}
      </li>`).join('');

    const ready = state.resumes.length;
    const failed = state.uploads.filter(u => u.status === 'failed').length;
    const waiting = queue.filter(q => q.status === 'queued').length;
    $('upload-summary').textContent = ready || failed || waiting
      ? [ready && `${ready} resume${ready === 1 ? '' : 's'} ready`, failed && `${failed} failed`, waiting && `${waiting} to read`].filter(Boolean).join(' · ')
      : 'No resumes added yet.';

    $('upload-btn').hidden = waiting === 0 && !busy;
    $('upload-btn').disabled = busy || waiting === 0;
    $('upload-btn').textContent = busy ? 'Reading…' : `Read ${waiting} resume${waiting === 1 ? '' : 's'}`;
    $('to-step-2').disabled = busy || ready === 0 || waiting > 0;
  }

  $('file-list').addEventListener('click', (event) => {
    if (busy) return;
    const queued = event.target.closest('[data-remove]');
    if (queued) {
      queue = queue.filter(q => q.id !== queued.dataset.remove);
    }
    const uploaded = event.target.closest('[data-remove-upload]');
    if (uploaded) {
      const [removed] = state.uploads.splice(Number(uploaded.dataset.removeUpload), 1);
      if (removed && removed.status === 'ok') {
        state.resumes = state.resumes.filter(r => r.id !== removed.id);
        state.saved = null;
      }
      save();
    }
    render();
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
      script.onerror = () => { jszipLoading = null; reject(new Error('Could not load the zip reader. Check your connection, or add the PDFs directly.')); };
      document.head.appendChild(script);
    });
    return jszipLoading;
  }

  // Zips are unpacked in the browser, so any size works and each PDF is tracked separately
  async function addFiles(fileList) {
    hideError($('step1-error'));
    const skipped = [];
    // Skip files already queued or read; a failed file can be added again
    const known = new Set([...queue, ...state.uploads.filter(u => u.status !== 'failed')].map(f => `${f.name}|${f.size}`));

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
    render();
    // Read new files straight away
    if (queue.some(q => q.status === 'queued') && !busy) uploadQueued();
  }

  $('upload-btn').addEventListener('click', uploadQueued);

  async function uploadQueued() {
    hideError($('step1-error'));
    busy = true;
    const pending = queue.filter(q => q.status === 'queued');
    for (let i = 0; i < pending.length; i += UPLOAD_BATCH) {
      const batch = pending.slice(i, i + UPLOAD_BATCH);
      batch.forEach(item => { item.status = 'uploading'; });
      renderStep1();

      const form = new FormData();
      batch.forEach(item => form.append('resume_pdf', item.file, item.name));

      let report = null;
      let batchError = null;
      try {
        report = (await api('/upload-resume', { form })).data.files;
      } catch (error) {
        if (error instanceof AuthRequired) { batch.forEach(item => { item.status = 'queued'; }); busy = false; return; }
        report = error.data && error.data.files;   // 400 "none readable" still has a per-file report
        batchError = error.message;
      }

      // The server reports files in the order they were sent
      batch.forEach((item, index) => {
        const result = report && report[index];
        let status = result ? result.status : 'failed';
        // The same resume content already added under another name counts as a duplicate
        if (status === 'ok' && state.resumes.some(r => r.id === result.id)) status = 'duplicate';
        if (status === 'ok') {
          state.resumes.push({ id: result.id, filename: item.name, size: item.size, text: result.resume });
          state.saved = null;
        }
        state.uploads.push({
          name: item.name,
          size: item.size,
          status,
          id: result ? result.id : null,
          error: status === 'failed' ? (result ? result.error : batchError) : ''
        });
      });
      queue = queue.filter(q => !batch.includes(q));
      save();
      renderStep1();
    }
    busy = false;
    render();
  }

  $('to-step-2').addEventListener('click', () => {
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
    goTo(2);
  });

  // ---------- Step 2: clarifying questions ----------

  let generating = false;
  let generationFailed = false;   // stops automatic retries; the user retries with the button

  function renderStep2() {
    // Questions belong to a JD: if the JD was edited, write new ones
    if (state.questions && state.questionsJd !== state.jd) {
      state.questions = null;
      state.answers = [];
      save();
    }
    if (!state.questions && !generating && !generationFailed && workspaceVisible()) generateQuestions();
    $('questions-loading').hidden = !generating;
    $('regenerate').hidden = generating || (!state.questions && !generationFailed);
    $('regenerate').textContent = state.questions ? 'New questions' : 'Try again';

    const list = $('questions');
    if (!state.questions) { list.innerHTML = ''; list.dataset.for = ''; updateAnswerState(); return; }

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
    $('start-screening').innerHTML = `Screen ${state.resumes.length} candidate${state.resumes.length === 1 ? '' : 's'} <span class="arrow" aria-hidden="true">→</span>`;
  }

  $('questions').addEventListener('input', (event) => {
    const index = event.target.dataset.index;
    if (index === undefined) return;
    state.answers[Number(index)] = event.target.value;
    save();
    updateAnswerState();
  });

  async function generateQuestions() {
    generating = true;
    generationFailed = false;
    hideError($('step2-error'));
    renderStep2();
    try {
      const data = await api('/generate-questions', { json: { jd: state.jd } });
      state.questions = data.data.questions;
      state.questionsJd = state.jd;
      state.answers = state.questions.map(() => '');
      save();
    } catch (error) {
      generationFailed = !(error instanceof AuthRequired);   // after sign-in, generate again automatically
      if (generationFailed) showError($('step2-error'), error.message);
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
    runScreening();
  });

  // ---------- Step 3: scoring and results ----------

  let screening = false;

  const answersPayload = () => state.questions.map((q, i) => ({ question: q.question, answer: (state.answers[i] || '').trim() }));

  // Scores are only valid for the JD and answers they were made with
  const scoresKey = () => JSON.stringify([state.jd, answersPayload()]);

  function currentScores() {
    if (state.scores.key !== scoresKey()) {
      state.scores = { key: scoresKey(), byId: {} };
      state.saved = null;
      save();
    }
    return state.scores.byId;
  }

  function rankedResults() {
    const byId = currentScores();
    return state.resumes
      .filter(r => byId[r.id])
      .map(r => ({ ...byId[r.id], filename: r.filename }))
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || String(a.candidate_name).localeCompare(String(b.candidate_name)))
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  const pendingResumes = () => { const byId = currentScores(); return state.resumes.filter(r => !byId[r.id]); };

  function renderStep3() {
    if (!state.questions) { goTo(2); return; }
    const done = pendingResumes().length === 0 && state.resumes.length > 0;
    $('results-view').hidden = !done || screening;
    $('progress-view').hidden = done && !screening;
    if (done && !screening) renderResults();
    else if (!screening && workspaceVisible() && $('step3-error').hidden) runScreening();   // e.g. after a refresh mid-run
  }

  function setProgress(done, total) {
    $('progress').classList.toggle('indeterminate', done === 0);
    $('progress-bar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
    $('progress-count').textContent = `${done} of ${total} resumes scored`;
  }

  async function runScreening({ restart = false } = {}) {
    if (screening) return;
    if (!state.questions) { goTo(2); return; }
    screening = true;
    if (restart) { state.scores = { key: scoresKey(), byId: {} }; state.saved = null; save(); }
    hideError($('step3-error'));
    $('retry-screening').hidden = true;
    $('progress-back').hidden = true;
    $('results-view').hidden = true;
    $('progress-view').hidden = false;

    const total = state.resumes.length;
    try {
      let pending = pendingResumes();
      setProgress(total - pending.length, total);
      while (pending.length) {
        const batch = pending.slice(0, SCORE_BATCH);
        const data = (await api('/score-resumes', {
          json: {
            jd: state.jd,
            answers: answersPayload(),
            resumes: batch.map(r => ({ id: r.id, filename: r.filename, resume: r.text }))
          }
        })).data;
        data.results.forEach((result, i) => { state.scores.byId[batch[i].id] = result; });
        save();
        pending = pendingResumes();
        setProgress(total - pending.length, total);
      }
    } catch (error) {
      screening = false;
      if (error instanceof AuthRequired) return;
      showError($('step3-error'), error.status === 400 && error.data && error.data.missing_answers
        ? `Some answers are missing (question ${error.data.missing_answers.join(', ')}). Go back and fill them in.`
        : error.message);
      $('retry-screening').hidden = false;
      $('progress-back').hidden = false;
      return;
    }
    screening = false;
    render();
  }

  $('retry-screening').addEventListener('click', () => runScreening());

  $('rerun').addEventListener('click', () => {
    if (!confirm('Score every resume again with the current answers?')) return;
    runScreening({ restart: true });
  });

  $('edit-answers').addEventListener('click', () => goTo(2));
  $('progress-back').addEventListener('click', () => { hideError($('step3-error')); goTo(2); });

  function renderResults() {
    const results = rankedResults();
    const count = (rec) => results.filter(r => r.recommendation === rec).length;
    const failed = count('Error');

    $('results-intro').textContent =
      `${results.length} candidate${results.length === 1 ? '' : 's'} for ${state.role}, scored against the job description and your ${state.questions.length} answers.` +
      (failed ? ` ${failed} resume${failed === 1 ? '' : 's'} could not be scored and ${failed === 1 ? 'is' : 'are'} listed as "Not scored"; use Re-run screening to try again.` : '');

    $('summary').innerHTML = `
      <div class="summary-card total"><div class="n">${results.length}</div><div class="k">Screened</div></div>
      ${['Strong Yes', 'Yes', 'Maybe', 'No'].map(label => `
        <div class="summary-card"><div class="n">${count(label)}</div><div class="k"><span class="badge ${BADGE[label]}">${label}</span></div></div>`).join('')}`;

    $('candidates').innerHTML = results.map((c, i) => {
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
            <div class="detail-grid">
              <div><h4>Strengths</h4>${list(c.strengths, '+')}</div>
              <div><h4>Gaps &amp; concerns</h4>${list(c.gaps, '−')}</div>
            </div>
            ${c.justification ? `<div class="justification"><h4>Why this score</h4>${esc(c.justification)}</div>` : ''}
            ${c.interview_priority ? `<p class="priority">Interview priority: <b>${esc(c.interview_priority)}</b></p>` : ''}
          </div>
        </li>`;
    }).join('');

    renderSaveState();
  }

  $('candidates').addEventListener('click', (event) => {
    const row = event.target.closest('.candidate-row');
    if (!row) return;
    const item = row.parentElement;
    const open = !item.classList.contains('open');
    item.classList.toggle('open', open);
    row.setAttribute('aria-expanded', String(open));
  });

  // ---------- Export ----------

  // Cells starting with = + - @ are prefixed so spreadsheet apps don't run them as formulas
  const csvCell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };

  function resultsCsv() {
    const header = ['Rank', 'Candidate', 'File', 'Score', 'Recommendation', 'Interview priority', 'Strengths', 'Gaps', 'Justification'];
    const rows = rankedResults().map(r => [
      r.rank, r.candidate_name, r.filename, r.score, r.recommendation, r.interview_priority,
      (r.strengths || []).join(' | '), (r.gaps || []).join(' | '), r.justification
    ]);
    return '﻿' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  }

  $('download-csv').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([resultsCsv()], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.role.replace(/[^\w\- ]+/g, '').trim() || 'screening'} - SmartHire results.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function renderSaveState() {
    const canSave = config.sheets || config.email;
    $('save-results').hidden = !canSave || Boolean(state.saved);
    $('save-results').textContent = config.sheets ? 'Save to Google Sheet' : 'Email summary to HR';
    const notice = $('save-notice');
    if (!state.saved) { notice.hidden = true; return; }
    const parts = [];
    if (state.saved.sheet_url) parts.push(`Saved to Google Sheets as “${esc(state.saved.tab)}”. <a href="${esc(state.saved.sheet_url)}" target="_blank" rel="noopener">Open sheet</a>`);
    if (state.saved.email_sent) parts.push('Summary emailed to HR.');
    notice.innerHTML = `<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="7.2" stroke="currentColor" stroke-width="1.5"/><path d="M5.8 9.2l2.2 2.2 4.2-4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${parts.join(' ') || 'Saved.'}</span>`;
    notice.hidden = false;
  }

  $('save-results').addEventListener('click', async () => {
    hideError($('save-error'));
    $('save-results').disabled = true;
    $('save-results').textContent = 'Saving…';
    try {
      const data = await api('/save-results', {
        json: { role: state.role, jd: state.jd, answers: answersPayload(), results: rankedResults() }
      });
      state.saved = data.data;
      save();
    } catch (error) {
      if (!(error instanceof AuthRequired)) showError($('save-error'), error.message);
    } finally {
      $('save-results').disabled = false;
      renderSaveState();
    }
  });

  // ---------- Start ----------

  async function init() {
    try {
      const health = await (await fetch(`${API}/health`)).json();
      const env = health.env_check || {};
      config = { passwordRequired: Boolean(env.password_required), sheets: Boolean(env.sheets_configured), email: Boolean(env.gmail_configured) };
    } catch {
      // The first real request will tell us if sign-in is needed
    }
    if (config.passwordRequired && !token) showGate();
    else showWorkspace();
  }

  init();
})();
