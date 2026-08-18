import './index.css';
import * as Sentry from '@sentry/electron/renderer';

Sentry.init({ dsn: 'https://e0a35240b3eb86faf9f387edf3613f65@o4511405360087040.ingest.de.sentry.io/4511683630071888' });

// ── State ─────────────────────────────────────────────────────────────────────
let currentScreen = 'home';
let selectedMode = null;

// Main recording
let mediaRecorder = null;
let audioChunks = [];
let recordingMimeType = 'audio/webm';
let timerInterval = null;
let secondsElapsed = 0;
let meterAnimFrame = null;
let audioContext = null;
let micAnalyser = null;
let sysAnalyser = null;
let mainAudioBlob = null;

// Feedback recording
let feedbackBlob = null;
let feedbackMimeType = '';
let feedbackRecorder = null;
let feedbackChunks = [];
let feedbackTimerInterval = null;
let feedbackSeconds = 0;

// Analysis state
let currentSession = null;     // session object currently open in screen-session
let editingSessionId = null;   // set when editing/re-analysing an existing session
let precallData = null;        // {mode, client_name, project_name, duration_seconds}
let mainTranscript = null;
let feedbackTranscript = null;
let currentAnalysis = null;

// Error retry
let lastErrorContext = null;

// ── Screen Navigation ─────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(`screen-${name}`).classList.remove('hidden');
  currentScreen = name;
}

// ── Error helpers ─────────────────────────────────────────────────────────────
const ERROR_MESSAGES = {
  'no-key':      { title: 'No API Key',           msg: 'No Groq API key found. Add your key in Settings before recording.' },
  'key-invalid': { title: 'Invalid API Key',       msg: 'Your Groq API key was rejected. Check that it\'s correct in Settings.' },
  'rate-limit':  { title: 'Rate Limit',            msg: 'Groq rate limit reached. Wait a moment and try again.' },
  'file-large':  { title: 'Recording Too Large',   msg: 'The recording file exceeded Groq\'s 25 MB limit. This shouldn\'t happen for normal calls — please report it.' },
  'timeout':     { title: 'Request Timed Out',     msg: 'Groq took longer than 2 minutes to respond. This may be a temporary issue — try again.' },
  'network':     { title: 'Network Error',         msg: 'Can\'t reach Groq. Check your internet connection and try again.' },
  'model-not-found': { title: 'AI Model Unavailable', msg: 'The AI model configured in this app no longer exists on Groq. Please update the app.' },
  'generic':     { title: 'Processing Failed',     msg: 'Something went wrong. Try again, or check your Settings if the issue persists.' },
};

function classifyError(err) {
  const status = err.status || 0;
  if (status === 401 || err.message?.includes('No API key')) return 'no-key';
  if (status === 401) return 'key-invalid';
  if (status === 429) return 'rate-limit';
  if (status === 413) return 'file-large';
  if (err.message === 'timeout' || status === 0) return 'timeout';
  if (status === 404 && err.message?.includes('does not exist')) return 'model-not-found';
  if (err.message?.toLowerCase().includes('network') || err.message?.toLowerCase().includes('fetch')) return 'network';
  return 'generic';
}

function showError(err, retryFn) {
  const key = classifyError(err);
  const { title, msg } = ERROR_MESSAGES[key] || ERROR_MESSAGES.generic;
  document.getElementById('error-title').textContent = title;
  document.getElementById('error-message').textContent = msg;
  lastErrorContext = retryFn || null;
  const retryBtn = document.getElementById('btn-error-retry');
  retryBtn.style.display = retryFn ? '' : 'none';
  showScreen('error');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-CA', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function modeBadgeHTML(mode) {
  return `<span class="mode-badge badge-${mode}">${mode}</span>`;
}

// ── Session List ──────────────────────────────────────────────────────────────
async function loadSessionList() {
  const sessions = await window.electronAPI.listSessions();
  const list = document.getElementById('session-list');
  if (!sessions.length) {
    list.innerHTML = '<div class="empty-state">No sessions yet. Start your first recording.</div>';
    return;
  }
  list.innerHTML = sessions.map(s => `
    <div class="session-row" data-id="${s.id}">
      <div class="session-row-mode mode-dot-${s.mode}"></div>
      <div class="session-row-info">
        <div class="session-row-client">${s.client_name || 'Untitled'} ${s.project_name ? '— ' + s.project_name : ''}</div>
        <div class="session-row-meta">${formatDate(s.created_at)} ${s.duration_seconds ? '· ' + formatDuration(s.duration_seconds) : ''}${s.analysis ? ' · <span class="session-analysed">✓ analysed</span>' : ''}</div>
        ${s.transcript ? `<div class="session-row-preview">${s.transcript.slice(0, 120)}…</div>` : ''}
      </div>
      ${modeBadgeHTML(s.mode)}
    </div>
  `).join('');

  list.querySelectorAll('.session-row').forEach(row => {
    row.addEventListener('click', () => openSession(Number(row.dataset.id)));
  });
}

async function openSession(id) {
  const session = await window.electronAPI.getSession(id);
  if (!session) return;
  currentSession = session;
  document.getElementById('session-view-title').textContent = session.client_name || 'Session';
  document.getElementById('session-view-meta').innerHTML =
    `${modeBadgeHTML(session.mode)} <span>${formatDate(session.created_at)}</span>` +
    (session.duration_seconds ? ` <span>· ${formatDuration(session.duration_seconds)}</span>` : '') +
    (session.project_name ? ` <span>· ${session.project_name}</span>` : '');
  document.getElementById('session-transcript').textContent = session.transcript || '(No transcript)';

  // Analysis tab
  const analysisTab = document.getElementById('session-tab-analysis');
  const analysisView = document.getElementById('session-analysis');
  if (session.analysis) {
    analysisTab.classList.remove('hidden');
    renderAnalysisView(analysisView, session.analysis, session.mode);
  } else {
    analysisTab.classList.add('hidden');
    analysisView.innerHTML = '';
  }
  await renderSessionFooter(session);

  // Always start on transcript tab
  switchSessionTab('transcript');
  showScreen('session');
}

function switchSessionTab(tab) {
  document.querySelectorAll('.session-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('session-transcript').classList.toggle('hidden', tab !== 'transcript');
  document.getElementById('session-analysis').classList.toggle('hidden', tab !== 'analysis');
}

function renderAnalysisView(container, analysis, mode) {
  container.innerHTML = '';

  const DISPLAY_TITLES = {
    summary: 'Summary', actionItems: 'Action Items', clickupTasks: 'ClickUp Tasks',
    openQuestions: 'Open Questions', extractedDates: 'Extracted Dates',
    sowDraft: 'SOW Draft', meetingNotesDraft: 'Meeting Notes Draft',
    decisions: 'Decisions', parkingLot: 'Parking Lot',
    commitments: 'Commitments', followUpEmailDraft: 'Follow-Up Email',
  };

  for (const field of SECTION_ORDER[mode]) {
    const value = analysis[field];
    if (!value) continue;

    const card = document.createElement('div');
    card.className = 'analysis-section';

    const heading = document.createElement('div');
    heading.className = 'analysis-section-title';
    heading.textContent = DISPLAY_TITLES[field];
    card.appendChild(heading);

    if (field === 'summary' || field === 'followUpEmailDraft') {
      const p = document.createElement('div');
      p.className = 'analysis-text';
      p.textContent = value;
      card.appendChild(p);

    } else if (field === 'sowDraft' || field === 'meetingNotesDraft') {
      const labels = field === 'sowDraft' ? SOW_LABELS : NOTES_LABELS;
      if (typeof value !== 'object') continue;

      const grid = document.createElement('div');
      grid.className = 'analysis-doc-grid';
      for (const [key, label] of Object.entries(labels)) {
        const v = value[key];
        if (!v) continue;
        const row = document.createElement('div');
        row.className = 'analysis-doc-row';
        row.innerHTML = `<span class="analysis-doc-label">${label}</span><span class="analysis-doc-value">${v}</span>`;
        grid.appendChild(row);
      }
      card.appendChild(grid);

    } else if (field === 'openQuestions') {
      if (!Array.isArray(value) || !value.length) continue;
      const ul = document.createElement('ul');
      ul.className = 'analysis-list';
      value.forEach(item => {
        const text = typeof item === 'string' ? item : item.text;
        if (!text) return;
        const li = document.createElement('li');
        li.textContent = text;
        ul.appendChild(li);
      });
      card.appendChild(ul);

    } else if (Array.isArray(value)) {
      const approved = value.filter(i => i.approved !== false);
      if (!approved.length) continue;
      const ul = document.createElement('ul');
      ul.className = 'analysis-list';
      approved.forEach(item => {
        let text;
        if (field === 'clickupTasks')   text = item.title + (item.description ? ` — ${item.description}` : '');
        else if (field === 'commitments') text = `${item.person}: ${item.commitment}`;
        else if (field === 'extractedDates') text = `${item.description} (${item.dateText})`;
        else text = item.text;
        if (!text) return;
        const li = document.createElement('li');
        li.textContent = text;
        ul.appendChild(li);
      });
      card.appendChild(ul);
    } else {
      continue;
    }

    container.appendChild(card);
  }
}

// ── Audio Capture ─────────────────────────────────────────────────────────────
async function startAudioCapture() {
  const streams = [];

  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    streams.push({ stream: micStream, label: 'mic' });
  } catch {
    showError({ message: 'Mic permission denied', status: 0 }, null);
    return null;
  }

  let sysStream = null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cableDevice = devices.find(d =>
      d.kind === 'audioinput' &&
      (d.label.toLowerCase().includes('cable output') ||
       d.label.toLowerCase().includes('vb-audio') ||
       d.label.toLowerCase().includes('voicemeeter output') ||
       d.label.toLowerCase().includes('voicemeeter vaio') ||
       d.label.toLowerCase().includes('voicemeeter out b1') ||
       d.label.toLowerCase().includes('voicemeeter out b'))
    );
    if (cableDevice) {
      sysStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: cableDevice.deviceId } },
        video: false,
      });
      streams.push({ stream: sysStream, label: 'system' });
      document.getElementById('rec-status').textContent = 'Recording… both audio streams active';
    } else {
      document.getElementById('rec-status').textContent =
        '⚠ System audio not detected — check VB-Audio Cable is set as your playback device';
    }
  } catch {
    document.getElementById('rec-status').textContent =
      '⚠ System audio unavailable — recording mic only';
  }

  audioContext = new AudioContext({ sampleRate: 16000 });
  const destination = audioContext.createMediaStreamDestination();

  streams.forEach(({ stream, label }) => {
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    const gainNode = audioContext.createGain();
    gainNode.gain.value = label === 'mic' ? 2.0 : 1.5;
    source.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(destination);
    if (label === 'mic') micAnalyser = analyser;
    else sysAnalyser = analyser;
  });

  return { mergedStream: destination.stream, rawStreams: streams.map(s => s.stream) };
}

function startLevelMeters() {
  const micBar = document.getElementById('meter-mic');
  const sysBar = document.getElementById('meter-system');

  function getRMS(analyser) {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const val = (data[i] - 128) / 128;
      sum += val * val;
    }
    return Math.sqrt(sum / data.length);
  }

  function tick() {
    const micPct  = Math.min(100, getRMS(micAnalyser) * 400);
    const sysPct  = Math.min(100, getRMS(sysAnalyser) * 400);
    micBar.style.width = micPct + '%';
    micBar.style.background = micPct > 80 ? '#C44F4F' : micPct > 50 ? '#D4A017' : '#3BAA6E';
    sysBar.style.width = sysPct + '%';
    sysBar.style.background = sysPct > 80 ? '#C44F4F' : sysPct > 50 ? '#D4A017' : '#3BAA6E';
    meterAnimFrame = requestAnimationFrame(tick);
  }
  tick();
}

function stopLevelMeters() {
  if (meterAnimFrame) { cancelAnimationFrame(meterAnimFrame); meterAnimFrame = null; }
  document.getElementById('meter-mic').style.width = '0%';
  document.getElementById('meter-system').style.width = '0%';
}

// ── Recording Prompts ─────────────────────────────────────────────────────────
const RECORDING_PROMPTS = {
  discover: [
    'What\'s the core problem or opportunity they\'re trying to solve?',
    'What have they already tried? What didn\'t work?',
    'Who are the stakeholders and who signs off?',
    'What does success look like in 6 months?',
    'Any hard deadlines or launch constraints?',
    'What\'s the rough budget range?',
    'Existing tools, platforms, or integrations to keep in mind?',
    'What\'s actively blocking them right now?',
    'What would be explicitly out of scope?',
    'Any competitors or comparisons they\'re referencing?',
  ],
  progress: [
    'What got completed since the last call?',
    'What\'s currently blocked and what\'s causing it?',
    'Any decisions that need to be made today?',
    'Has scope changed or are new requirements emerging?',
    'Any deadlines that are now at risk?',
    'Who owes what, and by when?',
    'Anything to park for a future conversation?',
    'What\'s the next milestone or checkpoint?',
  ],
  notes: [
    'Who is attending and what are their roles?',
    'What are the main topics being covered today?',
    'Any decisions made — and who owns them?',
    'Action items — who is responsible, by when?',
    'Anything deferred or tabled for later?',
    'Date and agenda for the next meeting?',
  ],
};

function loadRecordingPrompts(mode) {
  const prompts = RECORDING_PROMPTS[mode] || [];
  const list = document.getElementById('rec-prompts-list');
  list.innerHTML = prompts.map(p => `<li class="rec-prompt-item">${p}</li>`).join('');
  document.getElementById('rec-prompts').classList.remove('hidden');
}

// ── Main Recording Flow ───────────────────────────────────────────────────────
async function startRecording() {
  const capture = await startAudioCapture();
  if (!capture) return;

  const { mergedStream, rawStreams } = capture;

  const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
  recordingMimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'audio/webm';

  audioChunks = [];
  mediaRecorder = new MediaRecorder(mergedStream, { mimeType: recordingMimeType, audioBitsPerSecond: 64000 });
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.start(500);

  secondsElapsed = 0;
  document.getElementById('rec-timer').textContent = '00:00:00';
  timerInterval = setInterval(() => {
    secondsElapsed++;
    document.getElementById('rec-timer').textContent = formatDuration(secondsElapsed);
  }, 1000);

  startLevelMeters();
  loadRecordingPrompts(selectedMode);
  showScreen('recording');
  mediaRecorder._rawStreams = rawStreams;
}

async function stopRecording() {
  if (!mediaRecorder) return;

  clearInterval(timerInterval);
  stopLevelMeters();
  const duration = secondsElapsed;

  await new Promise(resolve => {
    mediaRecorder.onstop = resolve;
    mediaRecorder.stop();
  });

  mediaRecorder._rawStreams?.forEach(s => s.getTracks().forEach(t => t.stop()));
  if (audioContext) { audioContext.close(); audioContext = null; }
  micAnalyser = null; sysAnalyser = null;

  mainAudioBlob = new Blob(audioChunks, { type: recordingMimeType });
  audioChunks = [];

  precallData = {
    mode: selectedMode,
    client_name: document.getElementById('input-client').value.trim() || null,
    project_name: document.getElementById('input-project').value.trim() || null,
    duration_seconds: duration,
  };

  // Reset feedback state
  feedbackBlob = null;
  feedbackTranscript = null;
  mainTranscript = null;
  currentAnalysis = null;

  // Reset feedback UI
  document.getElementById('feedback-idle-ui').classList.remove('hidden');
  document.getElementById('feedback-recording-ui').classList.add('hidden');
  document.getElementById('feedback-recorded-ui').classList.add('hidden');
  document.getElementById('feedback-timer').textContent = '00:00';

  showScreen('feedback');
}

// ── Feedback Recording ────────────────────────────────────────────────────────
async function startFeedbackRecording() {
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
    feedbackMimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'audio/webm';

    feedbackChunks = [];
    feedbackRecorder = new MediaRecorder(micStream, { mimeType: feedbackMimeType, audioBitsPerSecond: 64000 });
    feedbackRecorder.ondataavailable = e => { if (e.data.size > 0) feedbackChunks.push(e.data); };
    feedbackRecorder._stream = micStream;
    feedbackRecorder.start(500);

    feedbackSeconds = 0;
    document.getElementById('feedback-timer').textContent = '00:00';
    feedbackTimerInterval = setInterval(() => {
      feedbackSeconds++;
      const m = Math.floor(feedbackSeconds / 60);
      const s = feedbackSeconds % 60;
      document.getElementById('feedback-timer').textContent =
        String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }, 1000);

    document.getElementById('feedback-idle-ui').classList.add('hidden');
    document.getElementById('feedback-recording-ui').classList.remove('hidden');
  } catch {
    // Mic unavailable — skip silently; user can still use the Skip button
  }
}

async function stopFeedbackRecording() {
  if (!feedbackRecorder) return;
  clearInterval(feedbackTimerInterval);

  await new Promise(resolve => {
    feedbackRecorder.onstop = resolve;
    feedbackRecorder.stop();
  });

  feedbackRecorder._stream?.getTracks().forEach(t => t.stop());
  feedbackBlob = new Blob(feedbackChunks, { type: feedbackMimeType });
  feedbackRecorder = null;
  feedbackChunks = [];

  document.getElementById('feedback-recording-ui').classList.add('hidden');
  document.getElementById('feedback-recorded-ui').classList.remove('hidden');
}

function clearFeedback() {
  feedbackBlob = null;
  document.getElementById('feedback-recorded-ui').classList.add('hidden');
  document.getElementById('feedback-idle-ui').classList.remove('hidden');
}

// ── Processing Pipeline ───────────────────────────────────────────────────────
function setProcessingStage(stage) {
  if (stage === 'transcribing') {
    document.getElementById('processing-title').textContent = 'Transcribing your recording…';
    document.getElementById('processing-sub').textContent = 'This usually takes 30–60 seconds depending on call length.';
  } else {
    document.getElementById('processing-title').textContent = 'Analysing…';
    document.getElementById('processing-sub').textContent = 'Running the transcript through Groq Llama 3.3. Almost there.';
  }
}

async function startProcessing() {
  showScreen('processing');
  setProcessingStage('transcribing');

  const doRun = async () => {
    try {
      // Parallel transcription: main audio + feedback (if any)
      const [mainTx, feedbackTx] = await Promise.all([
        window.electronAPI.transcribe(await mainAudioBlob.arrayBuffer(), recordingMimeType),
        feedbackBlob
          ? window.electronAPI.transcribe(await feedbackBlob.arrayBuffer(), feedbackMimeType)
          : Promise.resolve(null),
      ]);

      mainTranscript = mainTx;
      feedbackTranscript = feedbackTx;

      window.electronAPI.saveTranscriptDraft(mainTranscript).catch(() => {});

      setProcessingStage('analysing');

      const title = [precallData.client_name, precallData.project_name].filter(Boolean).join(' — ') || 'Untitled Session';

      const analysis = await window.electronAPI.analyze({
        transcript: mainTranscript,
        feedback: feedbackTranscript,
        mode: precallData.mode,
        title,
        clientName: precallData.client_name,
      });

      currentAnalysis = analysis;
      renderReviewScreen(analysis, precallData.mode);
      showScreen('review');
    } catch (err) {
      showError(err, doRun);
    }
  };

  await doRun();
}

// ── Review Screen ─────────────────────────────────────────────────────────────
const SECTION_TITLES = {
  summary:          'Summary',
  actionItems:      'Action Items',
  clickupTasks:     'ClickUp Tasks',
  openQuestions:    'Open Questions',
  extractedDates:   'Extracted Dates',
  sowDraft:         'SOW Draft',
  meetingNotesDraft:'Meeting Notes Draft',
  decisions:        'Decisions',
  parkingLot:       'Parking Lot',
  commitments:      'Commitments',
  followUpEmailDraft:'Follow-Up Email',
};

const SECTION_ORDER = {
  discover: ['summary', 'actionItems', 'clickupTasks', 'openQuestions', 'extractedDates', 'sowDraft', 'followUpEmailDraft'],
  progress: ['summary', 'actionItems', 'clickupTasks', 'decisions', 'parkingLot', 'commitments', 'extractedDates', 'meetingNotesDraft', 'followUpEmailDraft'],
  notes:    ['summary', 'actionItems', 'decisions', 'parkingLot', 'openQuestions', 'extractedDates', 'meetingNotesDraft', 'followUpEmailDraft'],
};

const SOW_LABELS = {
  problem_statement: 'Problem Statement', approach_summary: 'Approach Summary', next_steps_text: 'Next Steps',
  in_scope_1: 'In Scope 1', in_scope_2: 'In Scope 2', in_scope_3: 'In Scope 3',
  out_scope_1: 'Out of Scope 1', out_scope_2: 'Out of Scope 2',
  deliverable_1: 'Deliverable 1', deliverable_2: 'Deliverable 2', deliverable_3: 'Deliverable 3',
  phase1_focus: 'Phase 1 Focus', phase1_timing: 'Phase 1 Timing',
  phase2_focus: 'Phase 2 Focus', phase2_timing: 'Phase 2 Timing',
  phase3_focus: 'Phase 3 Focus', phase3_timing: 'Phase 3 Timing',
  line1_desc: 'Fee Line 1 Description', line1_amount: 'Fee Line 1 Amount',
  line2_desc: 'Fee Line 2 Description', line2_amount: 'Fee Line 2 Amount',
  project_fee: 'Project Fee', payment_terms: 'Payment Terms',
};

const NOTES_LABELS = {
  meeting_type: 'Meeting Type',
  key_point_1: 'Key Point 1', key_point_2: 'Key Point 2', key_point_3: 'Key Point 3',
  decision_1: 'Decision 1', decision_1_owner: 'Decision 1 Owner',
  decision_2: 'Decision 2', decision_2_owner: 'Decision 2 Owner',
  action_1_owner: 'Action 1 Owner', action_1_item: 'Action 1 Item', action_1_due: 'Action 1 Due',
  action_2_owner: 'Action 2 Owner', action_2_item: 'Action 2 Item', action_2_due: 'Action 2 Due',
  action_3_owner: 'Action 3 Owner', action_3_item: 'Action 3 Item', action_3_due: 'Action 3 Due',
  next_meeting_date: 'Next Meeting Date', next_meeting_time: 'Next Meeting Time', next_meeting_agenda: 'Next Meeting Agenda',
};

const SOW_MULTILINE  = new Set(['problem_statement', 'approach_summary', 'next_steps_text']);
const NOTES_MULTILINE = new Set(['next_meeting_agenda']);

function makeItemRow(displayText, approved, onTextChange, onApproveChange) {
  const row = document.createElement('div');
  row.className = 'review-item';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'review-checkbox';
  cb.checked = approved !== false;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'review-item-input';
  input.value = displayText || '';
  if (!cb.checked) input.classList.add('item-unapproved');

  cb.addEventListener('change', () => {
    onApproveChange(cb.checked);
    input.classList.toggle('item-unapproved', !cb.checked);
  });
  input.addEventListener('input', () => onTextChange(input.value));

  row.appendChild(cb);
  row.appendChild(input);
  return row;
}

function renderReviewScreen(analysis, mode) {
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  document.getElementById('review-title').textContent = `Review — ${modeLabel}`;
  const metaParts = [precallData.client_name, precallData.project_name].filter(Boolean);
  document.getElementById('review-meta').textContent = metaParts.join(' — ');

  const container = document.getElementById('review-sections');
  container.innerHTML = '';

  for (const field of SECTION_ORDER[mode]) {
    let value = analysis[field];

    const card = document.createElement('div');
    card.className = 'review-section';

    const heading = document.createElement('h3');
    heading.className = 'review-section-title';
    heading.textContent = SECTION_TITLES[field];
    card.appendChild(heading);

    if (field === 'summary' || field === 'followUpEmailDraft') {
      if (!value) continue;
      const ta = document.createElement('textarea');
      ta.className = 'review-textarea';
      ta.value = value;
      ta.rows = field === 'summary' ? 6 : 10;
      ta.addEventListener('input', () => { analysis[field] = ta.value; });
      card.appendChild(ta);

    } else if (field === 'sowDraft' || field === 'meetingNotesDraft') {
      const labels = field === 'sowDraft' ? SOW_LABELS : NOTES_LABELS;
      const multiline = field === 'sowDraft' ? SOW_MULTILINE : NOTES_MULTILINE;

      if (!value || typeof value !== 'object') {
        // Ensure field exists even if LLM omitted it
        analysis[field] = {};
        value = analysis[field];
      }

      const grid = document.createElement('div');
      grid.className = 'review-doc-grid';

      for (const [key, label] of Object.entries(labels)) {
        const row = document.createElement('div');
        row.className = 'review-doc-field';

        const lbl = document.createElement('label');
        lbl.className = 'review-doc-label';
        lbl.textContent = label;

        let inp;
        if (multiline.has(key)) {
          inp = document.createElement('textarea');
          inp.rows = 3;
          inp.className = 'review-doc-input review-doc-textarea';
        } else {
          inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'review-doc-input';
        }
        inp.value = value[key] ?? '';
        inp.addEventListener('input', () => { analysis[field][key] = inp.value; });

        row.appendChild(lbl);
        row.appendChild(inp);
        grid.appendChild(row);
      }
      card.appendChild(grid);

    } else if (field === 'openQuestions') {
      if (!Array.isArray(value) || !value.length) continue;
      // Normalize string array to objects
      const normalized = value.map((q, i) =>
        typeof q === 'string' ? { id: `q${i}`, text: q, approved: true } : q
      );
      analysis.openQuestions = normalized;

      const list = document.createElement('div');
      list.className = 'review-items';
      normalized.forEach(item => {
        list.appendChild(makeItemRow(
          item.text,
          item.approved,
          val => { item.text = val; },
          checked => { item.approved = checked; }
        ));
      });
      card.appendChild(list);

    } else if (Array.isArray(value)) {
      if (!value.length) continue;

      const list = document.createElement('div');
      list.className = 'review-items';

      value.forEach(item => {
        if (field === 'extractedDates') {
          const wrapper = document.createElement('div');
          wrapper.className = 'review-date-item';

          const row = makeItemRow(
            `${item.description} (${item.dateText})`,
            item.approved,
            val => { item.description = val.split(' (')[0]; },
            checked => { item.approved = checked; }
          );
          wrapper.appendChild(row);

          const dateRow = document.createElement('div');
          dateRow.className = 'review-date-iso-row';
          const dateLabel = document.createElement('span');
          dateLabel.className = 'review-date-iso-label';
          dateLabel.textContent = 'Calendar date:';
          const dateInput = document.createElement('input');
          dateInput.type = 'date';
          dateInput.className = 'review-date-iso-input';
          dateInput.value = item.isoDate ? item.isoDate.substring(0, 10) : '';
          dateInput.addEventListener('change', () => { item.isoDate = dateInput.value || null; });
          dateRow.appendChild(dateLabel);
          dateRow.appendChild(dateInput);
          wrapper.appendChild(dateRow);
          list.appendChild(wrapper);
        } else {
          let display;
          if (field === 'clickupTasks')  display = item.title + (item.description ? ` — ${item.description}` : '');
          else if (field === 'commitments') display = `${item.person}: ${item.commitment}`;
          else display = item.text;

          list.appendChild(makeItemRow(
            display,
            item.approved,
            val => {
              if (field === 'clickupTasks') item.title = val.split(' — ')[0];
              else if (field === 'commitments') item.commitment = val.includes(': ') ? val.split(': ').slice(1).join(': ') : val;
              else item.text = val;
            },
            checked => { item.approved = checked; }
          ));
        }
      });
      card.appendChild(list);
    } else {
      continue;
    }

    container.appendChild(card);
  }
}

function markAllApproved(analysis) {
  for (const val of Object.values(analysis)) {
    if (Array.isArray(val)) val.forEach(item => { if (item && typeof item === 'object') item.approved = true; });
  }
}

async function saveReviewedSession(saveAll) {
  if (saveAll) markAllApproved(currentAnalysis);

  if (editingSessionId) {
    // Overwrite existing session analysis in place
    await window.electronAPI.updateSession(editingSessionId, { analysis: currentAnalysis });
    const id = editingSessionId;
    editingSessionId = null;
    await loadSessionList();
    await openSession(id);
  } else {
    const sessionId = await window.electronAPI.saveSession({
      created_at: new Date().toISOString(),
      mode: precallData.mode,
      client_name: precallData.client_name,
      project_name: precallData.project_name,
      duration_seconds: precallData.duration_seconds,
      transcript: mainTranscript,
      feedback_transcript: feedbackTranscript,
      analysis: currentAnalysis,
    });
    await loadSessionList();
    await openSession(sessionId);
  }
}

function loadSessionIntoReviewState(session) {
  editingSessionId = session.id;
  precallData = {
    mode: session.mode,
    client_name: session.client_name,
    project_name: session.project_name,
    duration_seconds: session.duration_seconds,
  };
  mainTranscript = session.transcript;
  feedbackTranscript = session.feedback_transcript || null;
  currentAnalysis = JSON.parse(JSON.stringify(session.analysis)); // deep copy
}

function openSessionForEdit(session) {
  loadSessionIntoReviewState(session);
  renderReviewScreen(currentAnalysis, session.mode);
  showScreen('review');
}

async function reanalyseSession(session) {
  loadSessionIntoReviewState(session);
  showScreen('processing');
  document.getElementById('processing-title').textContent = 'Re-analysing…';
  document.getElementById('processing-sub').textContent = 'Running the transcript through the AI again.';

  const apiKey = await window.electronAPI.hasApiKey();
  if (!apiKey) {
    showError('no-key', () => reanalyseSession(session));
    return;
  }

  try {
    const result = await window.electronAPI.analyze({
      transcript: session.transcript,
      feedback: session.feedback_transcript || null,
      mode: session.mode,
      title: [session.client_name, session.project_name].filter(Boolean).join(' — '),
      clientName: session.client_name || '',
    });
    currentAnalysis = result;
    renderReviewScreen(currentAnalysis, session.mode);
    showScreen('review');
  } catch (err) {
    showError(classifyError(err), () => reanalyseSession(session));
  }
}

// ── Session Push Footer ───────────────────────────────────────────────────────
async function renderSessionFooter(session) {
  const footer = document.getElementById('session-footer');

  if (!session.analysis) {
    footer.innerHTML = '<div class="coming-soon">Run analysis to enable Drive, ClickUp &amp; Calendar push</div>';
    return;
  }

  const [googleConnected, cfg, cuKey] = await Promise.all([
    window.electronAPI.googleOAuthStatus(),
    window.electronAPI.getIntegrationConfig(),
    window.electronAPI.getClickupKey(),
  ]);

  const isDiscover = session.mode === 'discover';
  const templateId = isDiscover ? cfg?.driveProposalTemplateId : cfg?.driveMeetingNotesTemplateId;
  const driveReady = googleConnected && !!(templateId && cfg?.driveFolderId);
  const clickupReady = !!(cuKey && cfg?.clickupListId);
  const calendarReady = googleConnected;
  const pr = session.push_results || {};

  footer.innerHTML = `
    <div class="session-push-bar">
      <button class="push-btn${driveReady ? '' : ' push-btn-disabled'}" id="btn-push-drive" ${driveReady ? '' : 'disabled'} title="${driveReady ? 'Push to Google Drive' : 'Connect Google &amp; configure Drive in Settings'}">
        📄 Drive
      </button>
      ${isDiscover ? `
      <button class="push-btn${clickupReady ? '' : ' push-btn-disabled'}" id="btn-push-clickup" ${clickupReady ? '' : 'disabled'} title="${clickupReady ? 'Push approved tasks to ClickUp' : 'Add ClickUp key &amp; list ID in Settings'}">
        ✅ ClickUp
      </button>` : ''}
      <button class="push-btn${calendarReady ? '' : ' push-btn-disabled'}" id="btn-push-calendar" ${calendarReady ? '' : 'disabled'} title="${calendarReady ? 'Push approved dates to Calendar' : 'Connect Google in Settings'}">
        📅 Calendar
      </button>
      <div class="push-btn-divider"></div>
      <button class="push-btn" id="btn-edit-analysis" title="Edit approved items and doc draft">✏ Edit Analysis</button>
      <button class="push-btn" id="btn-reanalyse" title="Re-run AI analysis on the saved transcript">↺ Re-analyse</button>
    </div>
    <div class="push-results-row" id="push-results-row">
      ${pr.docUrl ? `<a class="push-result-link" href="${pr.docUrl}" target="_blank">📄 View Doc</a>` : ''}
      ${pr.taskCount ? `<span class="push-result-text">✅ ${pr.taskCount} task${pr.taskCount !== 1 ? 's' : ''} in ClickUp</span>` : ''}
      ${pr.eventUrls?.length ? pr.eventUrls.map((u, i) => `<a class="push-result-link" href="${u}" target="_blank">📅 Event${pr.eventUrls.length > 1 ? ` ${i+1}` : ''}</a>`).join('') : (pr.eventCount ? `<span class="push-result-text">📅 ${pr.eventCount} event${pr.eventCount !== 1 ? 's' : ''} in Calendar</span>` : '')}
    </div>
  `;

  document.getElementById('btn-push-drive')?.addEventListener('click', () => runPushDrive(session, cfg));
  if (isDiscover) {
    document.getElementById('btn-push-clickup')?.addEventListener('click', () => runPushClickup(session, cfg));
  }
  document.getElementById('btn-push-calendar')?.addEventListener('click', () => runPushCalendar(session));
  document.getElementById('btn-edit-analysis')?.addEventListener('click', () => openSessionForEdit(session));
  document.getElementById('btn-reanalyse')?.addEventListener('click', () => reanalyseSession(session));
}

async function runPushDrive(session, cfg) {
  const btn = document.getElementById('btn-push-drive');
  btn.disabled = true;
  btn.textContent = '📄 Pushing…';
  try {
    const isDiscover = session.mode === 'discover';
    const templateFileId = isDiscover ? cfg.driveProposalTemplateId : cfg.driveMeetingNotesTemplateId;
    const result = await window.electronAPI.pushDrive({ session, templateFileId, targetFolderId: cfg.driveFolderId });
    const updates = { push_results: { ...(session.push_results || {}), docUrl: result.docUrl } };
    await window.electronAPI.updateSession(session.id, updates);
    session.push_results = updates.push_results;
    await renderSessionFooter(session);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '📄 Drive';
    alert('Drive push failed: ' + err.message);
  }
}

async function runPushClickup(session, cfg) {
  const btn = document.getElementById('btn-push-clickup');
  btn.disabled = true;
  btn.textContent = '✅ Pushing…';
  try {
    const result = await window.electronAPI.pushClickup({ session, listId: cfg.clickupListId });
    const updates = { push_results: { ...(session.push_results || {}), taskCount: result.taskCount, taskUrls: result.urls } };
    await window.electronAPI.updateSession(session.id, updates);
    session.push_results = updates.push_results;
    await renderSessionFooter(session);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '✅ ClickUp';
    alert('ClickUp push failed: ' + err.message);
  }
}

async function runPushCalendar(session) {
  const btn = document.getElementById('btn-push-calendar');
  btn.disabled = true;
  btn.textContent = '📅 Pushing…';
  try {
    const result = await window.electronAPI.pushCalendar({ session });
    const updates = { push_results: { ...(session.push_results || {}), eventCount: result.eventCount, eventUrls: result.urls } };
    await window.electronAPI.updateSession(session.id, updates);
    session.push_results = updates.push_results;
    await renderSessionFooter(session);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '📅 Calendar';
    alert('Calendar push failed: ' + err.message);
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function updateGoogleStatus(connected) {
  const el = document.getElementById('google-status');
  if (!el) return;
  el.textContent = connected ? '✓ Connected' : 'Not connected';
  el.className = 'integration-status ' + (connected ? 'integration-status-connected' : 'integration-status-disconnected');
}

async function loadSettings() {
  const [key, googleConnected, cfg, cuKey] = await Promise.all([
    window.electronAPI.getApiKey(),
    window.electronAPI.googleOAuthStatus(),
    window.electronAPI.getIntegrationConfig(),
    window.electronAPI.getClickupKey(),
  ]);

  const input = document.getElementById('settings-key-input');
  const status = document.getElementById('key-status');
  if (key) {
    input.value = key;
    status.textContent = '✓ Key saved';
    status.className = 'settings-key-status status-saved';
  } else {
    input.value = '';
    status.textContent = 'No key set';
    status.className = 'settings-key-status status-none';
  }

  updateGoogleStatus(googleConnected);

  // Drive + ClickUp config
  if (cfg) {
    document.getElementById('settings-drive-proposal-template').value = cfg.driveProposalTemplateId || '';
    document.getElementById('settings-drive-notes-template').value = cfg.driveMeetingNotesTemplateId || '';
    document.getElementById('settings-drive-folder').value = cfg.driveFolderId || '';
    document.getElementById('settings-clickup-list').value = cfg.clickupListId || '';
  }
  if (cuKey) document.getElementById('settings-clickup-key').value = cuKey;

}

// ── Wire Up Events ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {

  // Home
  document.getElementById('btn-new-session').addEventListener('click', async () => {
    const hasKey = await window.electronAPI.hasApiKey();
    selectedMode = null;
    document.querySelectorAll('.mode-btn').forEach(b => b.className = 'mode-btn');
    document.getElementById('input-client').value = '';
    document.getElementById('input-project').value = '';
    document.getElementById('btn-start-recording').disabled = true;
    document.getElementById('no-key-warning').classList.toggle('hidden', hasKey);
    showScreen('precall');
    runAudioCheck();
  });

  document.getElementById('btn-settings-home').addEventListener('click', async () => {
    await loadSettings();
    showScreen('settings');
  });

  // Setup banner — show if Groq key missing and not already dismissed this session
  (async () => {
    const hasKey = await window.electronAPI.hasApiKey();
    const dismissed = sessionStorage.getItem('setup-banner-dismissed');
    if (!hasKey && !dismissed) {
      document.getElementById('setup-banner').classList.remove('hidden');
    }
  })();

  document.getElementById('btn-banner-settings').addEventListener('click', async () => {
    document.getElementById('setup-banner').classList.add('hidden');
    await loadSettings();
    showScreen('settings');
  });

  document.getElementById('btn-banner-dismiss').addEventListener('click', () => {
    sessionStorage.setItem('setup-banner-dismissed', '1');
    document.getElementById('setup-banner').classList.add('hidden');
  });

  // Pre-call
  document.getElementById('btn-back-precall').addEventListener('click', () => showScreen('home'));

  // ── Audio setup check ────────────────────────────────────────────────────
  async function runAudioCheck() {
    const icon  = document.getElementById('audio-check-icon');
    const label = document.getElementById('audio-check-label');
    const fix   = document.getElementById('btn-audio-fix');
    const detail = document.getElementById('audio-check-detail');

    icon.className = 'audio-check-icon';
    icon.textContent = '○';
    label.textContent = 'Checking audio setup…';
    fix.classList.add('hidden');
    detail.classList.add('hidden');

    const result = await window.electronAPI.checkAudio();

    if (result.error) {
      icon.className = 'audio-check-icon warn';
      icon.textContent = '⚠';
      label.textContent = 'Could not check audio devices';
      return;
    }

    const realtekOk = result.IsRealtekDefault;
    const cableOk   = result.CableOutputAvailable;

    if (realtekOk && cableOk) {
      icon.className = 'audio-check-icon ok';
      icon.textContent = '✓';
      label.textContent = 'Audio ready — Realtek speakers active, VB-Cable available';
    } else if (!realtekOk) {
      icon.className = 'audio-check-icon warn';
      icon.textContent = '⚠';
      label.textContent = `Wrong speaker active: ${result.DefaultPlayback}`;
      detail.textContent = 'Realtek speakers should be the default. Press Fix to correct it — Chrome audio will work normally after.';
      detail.classList.remove('hidden');
      fix.classList.remove('hidden');
    } else {
      icon.className = 'audio-check-icon warn';
      icon.textContent = '⚠';
      label.textContent = 'VB-Audio Cable not detected';
      detail.textContent = 'CABLE Output device not found. Make sure VB-Audio Cable is installed.';
      detail.classList.remove('hidden');
    }
  }

  document.getElementById('btn-audio-recheck').addEventListener('click', runAudioCheck);

  document.getElementById('btn-audio-fix').addEventListener('click', async () => {
    document.getElementById('audio-check-label').textContent = 'Fixing…';
    document.getElementById('btn-audio-fix').classList.add('hidden');
    await window.electronAPI.fixAudio();
    runAudioCheck();
  });

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedMode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b => b.className = 'mode-btn');
      btn.classList.add(`selected-${selectedMode}`);
      document.getElementById('btn-start-recording').disabled = false;
    });
  });

  document.getElementById('btn-go-settings-from-warning').addEventListener('click', async () => {
    await loadSettings();
    showScreen('settings');
  });

  document.getElementById('btn-start-recording').addEventListener('click', () => {
    document.getElementById('consent-banner').classList.remove('hidden');
  });

  document.getElementById('btn-consent-proceed').addEventListener('click', () => {
    document.getElementById('consent-banner').classList.add('hidden');
    startRecording();
  });

  document.getElementById('btn-consent-dismiss').addEventListener('click', () => {
    document.getElementById('consent-banner').classList.add('hidden');
    startRecording();
  });

  // Recording
  document.getElementById('btn-stop-recording').addEventListener('click', stopRecording);

  document.getElementById('btn-prompts-toggle').addEventListener('click', () => {
    const list = document.getElementById('rec-prompts-list');
    const btn = document.getElementById('btn-prompts-toggle');
    const collapsed = list.classList.toggle('hidden');
    btn.textContent = collapsed ? '▸' : '▾';
  });

  // Feedback
  document.getElementById('btn-back-feedback').addEventListener('click', () => {
    // If feedback recorder is running, stop it silently
    if (feedbackRecorder) {
      clearInterval(feedbackTimerInterval);
      feedbackRecorder._stream?.getTracks().forEach(t => t.stop());
      feedbackRecorder = null;
      feedbackChunks = [];
    }
    showScreen('recording');
  });

  document.getElementById('btn-feedback-start').addEventListener('click', startFeedbackRecording);
  document.getElementById('btn-feedback-stop').addEventListener('click', stopFeedbackRecording);
  document.getElementById('btn-feedback-clear').addEventListener('click', clearFeedback);
  document.getElementById('btn-feedback-skip').addEventListener('click', startProcessing);

  // Error
  document.getElementById('btn-error-retry').addEventListener('click', () => {
    if (lastErrorContext) {
      showScreen('processing');
      lastErrorContext();
    }
  });
  document.getElementById('btn-error-home').addEventListener('click', () => showScreen('home'));

  // Review
  document.getElementById('btn-back-review').addEventListener('click', () => {
    if (editingSessionId) {
      editingSessionId = null;
      showScreen('session');
    } else {
      showScreen('home');
    }
  });
  document.getElementById('btn-save-approved').addEventListener('click', () => saveReviewedSession(false));
  document.getElementById('btn-save-all').addEventListener('click', () => saveReviewedSession(true));

  // Session view — tabs
  document.getElementById('session-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.session-tab');
    if (tab) switchSessionTab(tab.dataset.tab);
  });
  document.getElementById('btn-back-session').addEventListener('click', () => showScreen('home'));

  // Settings
  document.getElementById('btn-back-settings').addEventListener('click', () => showScreen('home'));

  document.getElementById('btn-toggle-key').addEventListener('click', () => {
    const input = document.getElementById('settings-key-input');
    const btn = document.getElementById('btn-toggle-key');
    if (input.type === 'password') { input.type = 'text'; btn.textContent = 'Hide'; }
    else { input.type = 'password'; btn.textContent = 'Show'; }
  });

  document.getElementById('btn-save-key').addEventListener('click', async () => {
    const key = document.getElementById('settings-key-input').value.trim();
    const status = document.getElementById('key-status');
    if (!key) {
      status.textContent = 'Enter a key first';
      status.className = 'settings-key-status status-none';
      return;
    }
    status.textContent = 'Saving…';
    status.className = 'settings-key-status status-saving';
    await window.electronAPI.saveApiKey(key);
    status.textContent = '✓ Key saved';
    status.className = 'settings-key-status status-saved';
  });



  // ClickUp key show/hide
  document.getElementById('btn-toggle-clickup-key').addEventListener('click', () => {
    const inp = document.getElementById('settings-clickup-key');
    const btn = document.getElementById('btn-toggle-clickup-key');
    if (inp.type === 'password') { inp.type = 'text'; btn.textContent = 'Hide'; }
    else { inp.type = 'password'; btn.textContent = 'Show'; }
  });

  // Connect Google
  document.getElementById('btn-google-connect').addEventListener('click', async () => {
    const btn = document.getElementById('btn-google-connect');
    btn.disabled = true;
    btn.textContent = 'Opening browser…';
    try {
      await window.electronAPI.googleOAuthBegin();
      await updateGoogleStatus(true);
    } catch (err) {
      alert('Google connect failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect Google';
    }
  });

  // Disconnect Google
  document.getElementById('btn-google-disconnect').addEventListener('click', async () => {
    await window.electronAPI.googleOAuthDisconnect();
    await updateGoogleStatus(false);
  });

  // Save all integration settings (Drive IDs + ClickUp key + list ID)
  document.getElementById('btn-save-integrations').addEventListener('click', async () => {
    const cfg = {
      driveProposalTemplateId: document.getElementById('settings-drive-proposal-template').value.trim(),
      driveMeetingNotesTemplateId: document.getElementById('settings-drive-notes-template').value.trim(),
      driveFolderId: document.getElementById('settings-drive-folder').value.trim(),
      clickupListId: document.getElementById('settings-clickup-list').value.trim(),
    };
    const cuKey = document.getElementById('settings-clickup-key').value.trim();
    const statusEl = document.getElementById('clickup-key-status');
    statusEl.textContent = 'Saving…';
    statusEl.className = 'settings-key-status status-saving';
    await window.electronAPI.saveIntegrationConfig(cfg);
    if (cuKey) await window.electronAPI.saveClickupKey(cuKey);
    statusEl.textContent = '✓ Saved';
    statusEl.className = 'settings-key-status status-saved';
  });

  // Navigation from main menu
  window.electronAPI.onNavigate(async (screen) => {
    if (screen === 'settings') {
      await loadSettings();
      showScreen('settings');
    }
  });

  // Keyboard shortcut: Space to stop recording
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && currentScreen === 'recording' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      stopRecording();
    }
  });

  await loadSessionList();

  // ── VB-Audio first-run gate ───────────────────────────────────────────────
  document.getElementById('btn-vbaudio-download').addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal('https://vb-audio.com/Cable/');
  });

  document.getElementById('btn-vbaudio-recheck').addEventListener('click', async () => {
    const btn = document.getElementById('btn-vbaudio-recheck');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const result = await window.electronAPI.checkAudio();
    if (result.CableOutputAvailable) {
      showScreen('home');
    } else {
      btn.textContent = 'Not detected — try restarting your computer, then check again';
      btn.disabled = false;
    }
  });

  const audioResult = await window.electronAPI.checkAudio();
  if (!audioResult.CableOutputAvailable && !audioResult.error) {
    showScreen('vbaudio-setup');
  } else {
    showScreen('home');
  }
});
