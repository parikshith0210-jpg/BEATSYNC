// ─── Socket & Audio Context ───────────────────────────────────────────────────
const socket = io();
let audioCtx = null;
let masterGain = null;
let remoteVolume = 1;

function unlockAudio() {
  if (!audioCtx) {
    ensureAudioCtx();
    console.log('[Audio] Created audio context after user gesture');
  } else if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(() => {
      console.log('[Audio] Resumed audio context after user gesture');
    }).catch((err) => {
      console.warn('[Audio] Could not resume audio context:', err);
    });
  }
}
document.addEventListener('click', unlockAudio, { once: true });

socket.on('connect_error', (err) => {
  console.error('[Socket] connect_error', err);
  showStatus('error', `Socket connect failed: ${err.message || err}`);
});

socket.on('reconnect_attempt', () => {
  showStatus('info', 'Reconnecting to server...');
});

socket.on('reconnect', () => {
  showStatus('success', 'Reconnected to server');
});

socket.on('connect_timeout', () => {
  showStatus('error', 'Socket connection timed out');
});

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (!masterGain) {
    masterGain = audioCtx.createGain();
    masterGain.gain.value = remoteVolume;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// ─── Clock Synchronization ────────────────────────────────────────────────────
let clockOffset = 0;
async function calibrate() {
  const PINGS = 20;
  const results = [];
  for (let i = 0; i < PINGS; i++) {
    const t0 = performance.now();
    const clientSendMs = Date.now();
    socket.emit('getServerTime');
    await new Promise((resolve) => {
      socket.once('serverTime', (serverNow) => {
        const clientRecvMs = Date.now();
        const rtt = performance.now() - t0;
        const midpointMs = clientSendMs + ((clientRecvMs - clientSendMs) / 2);
        results.push({ offset: serverNow - midpointMs, rtt });
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 20));
  }
  results.sort((a, b) => a.rtt - b.rtt);
  const best = results.slice(0, 5);
  clockOffset = best.reduce((sum, r) => sum + r.offset, 0) / best.length;
  console.log(`[Sync] Clock offset: ${clockOffset.toFixed(1)} ms | Best RTT: ${results[0].rtt.toFixed(1)} ms`);
  updateSyncBadge(true);
}

function startCalibration() {
  calibrate();
  setInterval(calibrate, 30_000);
}

// ─── State ────────────────────────────────────────────────────────────────────
let currentSong = null;
let serverStartTime = null;
let activeSource = null;
let driftTimer = null;
let progressTimer = null;
let playbackStartedAt = null;
let currentAudioBuffer = null;
let currentSongDuration = 0;
let suppressRateResetUntil = 0;
let currentSourceOffsetSec = 0;
let currentSourceStartCtxSec = 0;
let scheduledStartTimeMs = null;
window.queue = [];

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect', () => {
  console.log('[Socket] Connected:', socket.id);
  socket.emit('requestState');
  startCalibration();
});

socket.on('disconnect', () => {
  updateSyncBadge(false);
});

socket.on('state', (data) => {
  currentSong = data.currentSong;
  serverStartTime = data.startTime;
  if (typeof data.globalVolume === 'number') {
    remoteVolume = data.globalVolume;
    if (masterGain) masterGain.gain.value = remoteVolume;
  }
  window.queue = data.queue || [];
  renderQueue(window.queue);
  renderNowPlaying();
  if (currentSong && serverStartTime) {
    schedulePlayback(currentSong, serverStartTime);
  }
});

socket.on('queueUpdate', (q) => {
  window.queue = q;
  renderQueue(q);
});

socket.on('deviceCount', (count) => {
  const label = document.getElementById('device-count');
  if (label) label.textContent = `${count} device${count === 1 ? '' : 's'}`;
});

socket.on('globalVolume', (vol) => {
  remoteVolume = Number(vol);
  if (masterGain) masterGain.gain.value = remoteVolume;
});

socket.on('status', ({ type, message }) => {
  showStatus(type, message);
});

// ─── Playback Scheduling ──────────────────────────────────────────────────────
let scheduledSongId = null;

async function schedulePlayback(song, srvStartTime) {
  ensureAudioCtx();
  if (scheduledSongId === song.id && scheduledStartTimeMs === srvStartTime) return;
  scheduledSongId = song.id;
  scheduledStartTimeMs = srvStartTime;
  serverStartTime = srvStartTime;
  
  if (activeSource) {
    try { activeSource.stop(); } catch (_) {}
    activeSource = null;
  }
  
  if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  suppressRateResetUntil = 0;
  
  console.log(`[Playback] Loading audio: /audio/${song.filename}`);
  try {
    const res = await fetch(`/audio/${song.filename}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    currentAudioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch (err) {
    console.error('[Playback] Failed to load audio:', err);
    showStatus('error', `Could not load audio: ${err.message}`);
    return;
  }
  
  currentSongDuration = song.duration || currentAudioBuffer.duration || 0;
  const localNow = Date.now() + clockOffset;
  const msUntilPlay = srvStartTime - localNow;
  const secondsUntilPlay = msUntilPlay / 1000;
  const when = audioCtx.currentTime + Math.max(0.1, secondsUntilPlay);
  
  console.log(`[Playback] Scheduling "${song.title}" in ${msUntilPlay.toFixed(0)} ms`);
  const source = startBufferedPlayback(currentAudioBuffer, when, 0);
  playbackStartedAt = performance.now() + msUntilPlay;
  
  // Simple drift correction: nudge playback rate every 1s
  driftTimer = setInterval(() => {
    if (!activeSource) return;
    const nowServerMs = Date.now() + clockOffset;
    const targetPositionSec = Math.max(0, (nowServerMs - serverStartTime) / 1000);
    const actualPositionSec = Math.max(0, currentSourceOffsetSec + (audioCtx.currentTime - currentSourceStartCtxSec));
    const driftMs = (actualPositionSec - targetPositionSec) * 1000;
    
    if (Math.abs(driftMs) > 5) {
      const direction = driftMs > 0 ? -1 : 1;
      const magnitude = Math.min(0.01, Math.max(0.002, Math.abs(driftMs) / 5000));
      activeSource.playbackRate.value = 1 + (direction * magnitude);
      const token = Date.now() + 500;
      suppressRateResetUntil = token;
      setTimeout(() => {
        if (activeSource && suppressRateResetUntil === token) {
          activeSource.playbackRate.value = 1.0;
        }
      }, 500);
      console.log(`[Sync] Nudged playback by ${driftMs.toFixed(1)} ms`);
    }
  }, 1000);
  
  progressTimer = setInterval(() => {
    const elapsed = Math.max(0, (performance.now() - playbackStartedAt) / 1000);
    const total = currentSongDuration || 1;
    const pct = Math.min(100, (elapsed / total) * 100);
    const bar = document.getElementById('progress-bar');
    if (bar) bar.style.width = `${pct}%`;
  }, 500);
  
  const nextSong = window.queue?.[0];
  if (nextSong) {
    fetch(`/audio/${nextSong.filename}`).catch(() => {});
  }
}

// ─── UI Rendering ─────────────────────────────────────────────────────────────
function startBufferedPlayback(audioBuffer, whenCtxSec, offsetSec) {
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(masterGain || audioCtx.destination);
  source.playbackRate.value = 1.0;
  const boundedOffsetSec = Math.max(0, offsetSec);
  source.start(whenCtxSec, boundedOffsetSec);
  activeSource = source;
  currentSourceOffsetSec = boundedOffsetSec;
  currentSourceStartCtxSec = whenCtxSec;
  
  source.onended = () => {
    if (source === activeSource) {
      activeSource = null;
      scheduledSongId = null;
      scheduledStartTimeMs = null;
      currentAudioBuffer = null;
      currentSourceOffsetSec = 0;
      currentSourceStartCtxSec = 0;
      if (driftTimer) clearInterval(driftTimer);
      if (progressTimer) clearInterval(progressTimer);
      driftTimer = null;
      progressTimer = null;
    }
  };
  return source;
}

function renderNowPlaying() {
  const titleEl = document.getElementById('np-title');
  const vinyl = document.getElementById('vinyl');
  const card = document.getElementById('now-playing-card');
  const bar = document.getElementById('progress-bar');
  
  if (currentSong) {
    titleEl.textContent = currentSong.title;
    vinyl.classList.add('spinning');
    card.classList.add('active');
    if (bar) bar.style.width = '0%';
  } else {
    titleEl.textContent = 'Nothing playing yet';
    vinyl.classList.remove('spinning');
    card.classList.remove('active');
    if (bar) bar.style.width = '0%';
  }
}

function renderQueue(q) {
  const ol = document.getElementById('queue-list');
  const countEl = document.getElementById('queue-count');
  countEl.textContent = q.length ? `(${q.length})` : '';
  
  if (!q.length) {
    ol.innerHTML = '<li class="queue-empty">Queue is empty</li>';
    return;
  }
  
  ol.innerHTML = q.map((song) => `
    <li class="queue-item" data-id="${escHtml(song.id)}">
      <span class="queue-title">${escHtml(song.title)}</span>
      <span class="queue-dur">${formatDuration(song.duration)}</span>
      <div class="queue-actions">
        <button class="btn-remove" onclick="removeFromQueue('${escHtml(song.id)}')">✕</button>
      </div>
    </li>
  `).join('');
}

function showStatus(type, message) {
  const bar = document.getElementById('status-bar');
  bar.textContent = message;
  bar.className = `status-bar status-${type}`;
  clearTimeout(bar._timer);
  bar._timer = setTimeout(() => { bar.className = 'status-bar hidden'; }, 5000);
}

function updateSyncBadge(synced) {
  const badge = document.getElementById('sync-badge');
  if (synced) {
    badge.textContent = '✓ Synced';
    badge.className = 'sync-badge synced';
  } else {
    badge.textContent = 'Syncing...';
    badge.className = 'sync-badge';
  }
}

// ─── UI Actions ───────────────────────────────────────────────────────────────
function add() {
  ensureAudioCtx();
  const input = document.getElementById('url-input');
  const url = input.value.trim();
  if (!url) return;
  socket.emit('addYoutube', url);
  input.value = '';
  showStatus('info', 'Sending to server…');
}

function skip() {
  socket.emit('skip');
}

function removeFromQueue(songId) {
  socket.emit('removeFromQueue', songId);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}