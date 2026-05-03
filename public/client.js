// ─── Socket & Audio Context ───────────────────────────────────────────────────
const socket = io();
let audioCtx = null; // Created on first user gesture (browser policy)
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
// We measure the offset between our local clock and the server clock.
// By doing 20 rapid pings and keeping only the fastest round-trips,
// we get a highly accurate offset (usually within 1–2 ms on a LAN).

let clockOffset = 0; // ms: serverTime = Date.now() + clockOffset

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
    // Small gap between pings to avoid flooding
    await new Promise((r) => setTimeout(r, 20));
  }

  // Use the fastest ping (lowest RTT) for best accuracy
  results.sort((a, b) => a.rtt - b.rtt);
  const best = results.slice(0, 5); // top 5
  clockOffset = best.reduce((sum, r) => sum + r.offset, 0) / best.length;

  console.log(`[Sync] Clock offset: ${clockOffset.toFixed(1)} ms | Best RTT: ${results[0].rtt.toFixed(1)} ms`);
  updateSyncBadge(true);
}

// Re-calibrate every 30 seconds to handle clock drift
function startCalibration() {
  calibrate();
  setInterval(calibrate, 30_000);
  // CUSTOM 3: Report network metrics every 10 seconds
  setInterval(() => {
    const t0 = performance.now();
    socket.emit('getServerTime');
    socket.once('serverTime', () => {
      const rtt = performance.now() - t0;
      socket.emit('reportRTT', rtt);
    });
  }, 10_000);
}

// ─── Advanced Sync Layers ─────────────────────────────────────────────────────
// Layer 1: Rhythm Consensus Protocol
class RhythmConsensus {
  constructor() {
    this.heartbeats = new Map(); // deviceId -> { positionSec, serverTimeMs, receivedAtMs }
    this.maxAgeMs = 1800;
    this.outlierThresholdSec = 0.08;
    this.minimumCandidates = 2;
    this.maxInlierSpreadSec = 0.045;
  }

  updateLocalPosition(deviceId, positionSec) {
    if (!deviceId) return;
    const now = Date.now();
    this.heartbeats.set(deviceId, {
      positionSec,
      serverTimeMs: now + clockOffset,
      receivedAtMs: now
    });
  }

  broadcastHeartbeat(positionSec) {
    if (!socket.id) return;
    socket.emit('heartbeat', {
      deviceId: socket.id,
      audioPosition: positionSec,
      serverTime: Date.now() + clockOffset
    });
  }

  receiveHeartbeat(data) {
    if (!data?.deviceId || typeof data.audioPosition !== 'number') return;
    this.heartbeats.set(data.deviceId, {
      positionSec: data.audioPosition,
      serverTimeMs: typeof data.serverTime === 'number' ? data.serverTime : Date.now() + clockOffset,
      receivedAtMs: Date.now()
    });
  }

  getConsensus(nowServerMs) {
    const candidates = [];
    for (const [deviceId, heartbeat] of this.heartbeats.entries()) {
      if (Date.now() - heartbeat.receivedAtMs > this.maxAgeMs) {
        this.heartbeats.delete(deviceId);
        continue;
      }
      const projected = heartbeat.positionSec + Math.max(0, (nowServerMs - heartbeat.serverTimeMs) / 1000);
      candidates.push(projected);
    }

    if (candidates.length < this.minimumCandidates) return null;
    candidates.sort((a, b) => a - b);
    const median = candidates[Math.floor(candidates.length / 2)];
    const inliers = candidates.filter((value) => Math.abs(value - median) <= this.outlierThresholdSec);
    if (inliers.length < this.minimumCandidates) return null;
    const spreadSec = inliers[inliers.length - 1] - inliers[0];
    if (spreadSec > this.maxInlierSpreadSec) return null;
    return inliers[Math.floor(inliers.length / 2)];
  }
}

// Layer 2: Predictive Drift Forecasting
class PredictiveDrift {
  constructor() {
    this.samples = [];
    this.maxSamples = 16;
  }

  update(nowMs, driftMs) {
    this.samples.push({ nowMs, driftMs });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  predict(horizonMs = 2000) {
    if (this.samples.length < 3) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = last.nowMs - first.nowMs;
    if (dt <= 0) return last.driftMs;
    const slope = (last.driftMs - first.driftMs) / dt;
    return last.driftMs + slope * horizonMs;
  }
}

// Layer 3: Acoustic Watermark Echo Chamber
class AcousticWatermark {
  constructor() {
    this.enabled = false;
  }

  detectCorrectionMs() {
    // Browser-safe placeholder until microphone DSP + watermark injection exist.
    return 0;
  }
}

// Layer 4: Beat Lattice
class BeatLattice {
  constructor() {
    this.lattice = null;
  }

  setLattice(data) {
    this.lattice = data || null;
  }

  getNearestBeatCorrectionMs(nowServerMs) {
    if (!this.lattice?.bpm || !this.lattice?.startTime) return 0;
    const beatInterval = 60000 / this.lattice.bpm;
    const beatIndex = Math.max(0, Math.round((nowServerMs - this.lattice.startTime) / beatInterval));
    const nearestBeatTime = this.lattice.startTime + beatIndex * beatInterval;
    const delta = nearestBeatTime - nowServerMs;
    return Math.abs(delta) <= beatInterval * 0.2 ? delta : 0;
  }
}

// Layer 5: Correction Confidence / escalation policy
class CorrectionPolicy {
  constructor() {
    this.microNudgeMs = 14;
    this.rescheduleMs = 48;
    this.dropLateMs = 120;
    this.holdEarlyMs = 95;
    this.minHardCorrectionGapMs = 1200;
  }

  classify(totalCorrectionMs) {
    if (totalCorrectionMs >= this.dropLateMs) return 'drop-late';
    if (totalCorrectionMs <= -this.holdEarlyMs) return 'hold-early';
    const magnitude = Math.abs(totalCorrectionMs);
    if (magnitude >= this.rescheduleMs) return 'reschedule-soft';
    if (magnitude >= this.microNudgeMs) return 'nudge';
    return 'hold';
  }
}

class AdaptiveSyncProfile {
  constructor() {
    this.mode = 'lan';
    this.isAnchor = false;
  }

  getLabel() {
    if (this.mode === 'weak-wifi') return 'Weak Wi-Fi';
    if (this.mode === 'stable-wifi') return 'Stable Wi-Fi';
    return 'LAN';
  }
}

// Sync Cortex: integrates real, browser-viable layers
class SyncCortex {
  constructor() {
    this.consensus = new RhythmConsensus();
    this.predictive = new PredictiveDrift();
    this.acoustic = new AcousticWatermark();
    this.lattice = new BeatLattice();
    this.policy = new CorrectionPolicy();
    this.profile = new AdaptiveSyncProfile();
    this.weights = { consensus: 0.45, predictive: 0.15, beat: 0.1, acoustic: 1.2 };
    this.requiredHardCorrectionSamples = 2;
  }

  setAnchorRole(isAnchor) {
    this.profile.isAnchor = Boolean(isAnchor);
    this.setAdaptiveMode(this.profile.mode);
  }

  setAdaptiveMode(mode) {
    this.profile.mode = mode || 'lan';
    if (this.profile.mode === 'weak-wifi') {
      this.policy.microNudgeMs = 22;
      this.policy.rescheduleMs = 72;
      this.policy.dropLateMs = 160;
      this.policy.holdEarlyMs = 130;
      this.policy.minHardCorrectionGapMs = 2200;
      this.consensus.maxAgeMs = 2600;
      this.consensus.outlierThresholdSec = 0.14;
      this.consensus.minimumCandidates = 3;
      this.consensus.maxInlierSpreadSec = 0.09;
      this.weights = { consensus: 0.3, predictive: 0.1, beat: 0.05, acoustic: 1.2 };
      this.requiredHardCorrectionSamples = 3;
      this.applyAnchorGuardrails();
      return;
    }

    if (this.profile.mode === 'stable-wifi') {
      this.policy.microNudgeMs = 18;
      this.policy.rescheduleMs = 58;
      this.policy.dropLateMs = 135;
      this.policy.holdEarlyMs = 110;
      this.policy.minHardCorrectionGapMs = 1700;
      this.consensus.maxAgeMs = 2200;
      this.consensus.outlierThresholdSec = 0.11;
      this.consensus.minimumCandidates = 2;
      this.consensus.maxInlierSpreadSec = 0.07;
      this.weights = { consensus: 0.36, predictive: 0.12, beat: 0.08, acoustic: 1.2 };
      this.requiredHardCorrectionSamples = 3;
      this.applyAnchorGuardrails();
      return;
    }

    this.policy.microNudgeMs = 14;
    this.policy.rescheduleMs = 48;
    this.policy.dropLateMs = 120;
    this.policy.holdEarlyMs = 95;
    this.policy.minHardCorrectionGapMs = 1200;
    this.consensus.maxAgeMs = 1800;
    this.consensus.outlierThresholdSec = 0.08;
    this.consensus.minimumCandidates = 2;
    this.consensus.maxInlierSpreadSec = 0.045;
    this.weights = { consensus: 0.45, predictive: 0.15, beat: 0.1, acoustic: 1.2 };
    this.requiredHardCorrectionSamples = 2;
    this.applyAnchorGuardrails();
  }

  applyAnchorGuardrails() {
    if (!this.profile.isAnchor) return;
    this.policy.rescheduleMs += 18;
    this.policy.dropLateMs += 35;
    this.policy.holdEarlyMs += 30;
    this.policy.minHardCorrectionGapMs += 1200;
    this.weights.consensus *= 0.75;
    this.weights.predictive *= 0.8;
    this.requiredHardCorrectionSamples += 2;
  }

  getCorrection(nowServerMs, currentPositionSec) {
    const parts = [];

    const consensusPos = this.consensus.getConsensus(nowServerMs);
    if (consensusPos !== null) {
      parts.push({ weight: this.weights.consensus, ms: (consensusPos - currentPositionSec) * 1000 });
    }

    const predictedDriftMs = this.predictive.predict(2000);
    parts.push({ weight: this.weights.predictive, ms: predictedDriftMs });

    const beatCorrectionMs = this.lattice.getNearestBeatCorrectionMs(nowServerMs);
    if (beatCorrectionMs !== 0) {
      parts.push({ weight: this.weights.beat, ms: beatCorrectionMs });
    }

    const acousticCorrectionMs = this.acoustic.detectCorrectionMs();
    if (acousticCorrectionMs !== 0) {
      parts.push({ weight: this.weights.acoustic, ms: acousticCorrectionMs });
    }

    if (!parts.length) {
      return { totalMs: 0, mode: 'hold', parts: [] };
    }

    const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
    const weightedMs = parts.reduce((sum, part) => sum + part.ms * part.weight, 0) / totalWeight;
    const clampedMs = Math.max(-120, Math.min(120, weightedMs));

    return {
      totalMs: clampedMs,
      mode: this.policy.classify(clampedMs),
      parts
    };
  }
}

function getTargetPlaybackPositionSec(nowServerMs = Date.now() + clockOffset) {
  if (!serverStartTime) return 0;
  return Math.max(0, (nowServerMs - serverStartTime) / 1000);
}

function getCurrentPlaybackPositionSec() {
  if (!activeSource || !audioCtx) return 0;
  return Math.max(0, currentSourceOffsetSec + (audioCtx.currentTime - currentSourceStartCtxSec));
}

function updateHardCorrectionStreak(mode) {
  const hardModes = new Set(['drop-late', 'hold-early', 'reschedule-soft']);
  if (!hardModes.has(mode)) {
    hardCorrectionStreak = 0;
    lastHardCorrectionKind = '';
    return 0;
  }
  if (lastHardCorrectionKind === mode) {
    hardCorrectionStreak += 1;
  } else {
    lastHardCorrectionKind = mode;
    hardCorrectionStreak = 1;
  }
  return hardCorrectionStreak;
}

const syncCortex = new SyncCortex();
syncCortex.setAdaptiveMode('lan');

// ─── State ────────────────────────────────────────────────────────────────────
let currentSong = null;
let serverStartTime = null; // server unix ms when playback begins

let activeSource = null;     // current AudioBufferSourceNode
let driftTimer = null;
let progressTimer = null;
let playbackStartedAt = null; // local performance.now() when audio started
let currentAudioBuffer = null;
let currentSongDuration = 0;
let suppressRateResetUntil = 0;
let recoveryUntilPerf = 0;
let currentSourceOffsetSec = 0;
let currentSourceStartCtxSec = 0;
let scheduledStartTimeMs = null;
let lastHardCorrectionPerf = 0;
let lastHardCorrectionKind = '';
let hardCorrectionStreak = 0;
window.queue = [];

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect', () => {
  console.log('[Socket] Connected:', socket.id);
  socket.emit('requestState');
  socket.emit('requestBeatLattice'); // Request beat lattice for sync
  startCalibration();
  loadHistory();
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
  window.favorites = new Set(data.favorites || []);
  renderQueue(window.queue);
  renderNowPlaying();
  if (currentSong && serverStartTime) {
    socket.emit('requestBeatLattice'); // Update lattice on song change
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

// ─── Feature 37: Vote-to-Skip UI ──────────────────────────────────────────────
socket.on('skipVotes', ({ current, needed }) => {
  const voteDisplay = document.getElementById('skip-votes');
  if (voteDisplay) voteDisplay.textContent = `${current}/${needed}`;
});

// ─── Feature 38 & 39: History, Favorites, Ratings ────────────────────────────
socket.on('history', (h) => {
  window.history = h;
  renderHistory();
});

socket.on('favoritesUpdate', (fav) => {
  window.favorites = new Set(fav);
  renderQueue(window.queue);
});

socket.on('ratingsUpdate', (ratings) => {
  window.ratings = new Map(Object.entries(ratings));
  renderQueue(window.queue);
});

// ─── CUSTOM 3: Network Quality Indicator ──────────────────────────────────────
socket.on('networkQuality', ({ quality, rtt, jitter, profile }) => {
  const previousMode = syncCortex.profile.mode;
  syncCortex.setAdaptiveMode(profile);
  const badge = document.getElementById('network-quality');
  if (badge) {
    badge.textContent = `${quality.toUpperCase()} ${syncCortex.profile.getLabel()} (${rtt}ms/${jitter}j)`;
    badge.className = `network-badge ${quality}`;
  }
  if (previousMode !== syncCortex.profile.mode) {
    showStatus('info', `Adaptive sync: ${syncCortex.profile.getLabel()}`);
  }
});

socket.on('syncRole', ({ role }) => {
  const wasAnchor = syncCortex.profile.isAnchor;
  syncCortex.setAnchorRole(role === 'anchor');
  if (wasAnchor !== syncCortex.profile.isAnchor) {
    showStatus('info', syncCortex.profile.isAnchor ? 'Sync role: host-priority anchor' : 'Sync role: peer');
  }
});

// ─── Advanced Sync Events ─────────────────────────────────────────────────────
socket.on('heartbeat', (data) => {
  syncCortex.consensus.receiveHeartbeat(data);
});

socket.on('beatLattice', (data) => {
  syncCortex.lattice.setLattice(data);
});


// ─── Playback Scheduling ──────────────────────────────────────────────────────
let scheduledSongId = null;

async function schedulePlayback(song, srvStartTime) {
  ensureAudioCtx();

  // Don't re-schedule the same song
  if (scheduledSongId === song.id && scheduledStartTimeMs === srvStartTime) return;
  scheduledSongId = song.id;
  scheduledStartTimeMs = srvStartTime;
  serverStartTime = srvStartTime;

  // Stop any currently playing audio
  if (activeSource) {
    try { activeSource.stop(); } catch (_) {}
    activeSource = null;
  }
  if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  suppressRateResetUntil = 0;
  recoveryUntilPerf = 0;
  lastHardCorrectionPerf = 0;
  lastHardCorrectionKind = '';
  hardCorrectionStreak = 0;

  // Fetch and decode the audio file from local server
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

  // Calculate exactly when to start, in local audioCtx time
  // serverNow ≈ Date.now() + clockOffset
  const localNow = Date.now() + clockOffset; // our best estimate of server time right now
  const msUntilPlay = srvStartTime - localNow;
  const secondsUntilPlay = msUntilPlay / 1000;
  const when = audioCtx.currentTime + Math.max(0.1, secondsUntilPlay);

  console.log(`[Playback] Scheduling "${song.title}" in ${msUntilPlay.toFixed(0)} ms`);

  const source = startBufferedPlayback(currentAudioBuffer, when, 0);

  playbackStartedAt = performance.now() + msUntilPlay;

  // Keep the server timeline as the primary truth.
  // The backup layers only bias the correction; they do not replace the live edge.
  driftTimer = setInterval(() => {
    if (!activeSource) return;
    const nowPerf = performance.now();
    if (nowPerf < recoveryUntilPerf) return;
    const nowServerMs = Date.now() + clockOffset;
    const targetPositionSec = getTargetPlaybackPositionSec(nowServerMs);
    const actualPositionSec = getCurrentPlaybackPositionSec();
    const timingErrorMs = (actualPositionSec - targetPositionSec) * 1000;

    syncCortex.predictive.update(nowPerf, timingErrorMs);
    syncCortex.consensus.updateLocalPosition(socket.id, actualPositionSec);

    const correction = syncCortex.getCorrection(nowServerMs, actualPositionSec);
    const totalCorrectionMs = timingErrorMs + correction.totalMs;
    const canHardCorrect = (nowPerf - lastHardCorrectionPerf) >= syncCortex.policy.minHardCorrectionGapMs;
    const hardStreak = updateHardCorrectionStreak(correction.mode);
    const streakReady = hardStreak >= syncCortex.requiredHardCorrectionSamples;

    if (correction.mode === 'drop-late') {
      if (canHardCorrect && streakReady) {
        jumpToLiveEdge(targetPositionSec);
        lastHardCorrectionPerf = nowPerf;
        hardCorrectionStreak = 0;
        console.log(`[Sync] Dropped late audio and jumped to live edge (${totalCorrectionMs.toFixed(1)} ms late)`);
      }
    } else if (correction.mode === 'hold-early') {
      if (canHardCorrect && streakReady) {
        holdForLiveCatchUp(actualPositionSec, Math.abs(totalCorrectionMs));
        lastHardCorrectionPerf = nowPerf;
        hardCorrectionStreak = 0;
        console.log(`[Sync] Held early audio for ${Math.abs(totalCorrectionMs).toFixed(1)} ms`);
      }
    } else if (correction.mode === 'reschedule-soft') {
      if (canHardCorrect && streakReady) {
        restartPlaybackAtPosition(targetPositionSec);
        lastHardCorrectionPerf = nowPerf;
        hardCorrectionStreak = 0;
        console.log(`[Sync] Soft-rescheduled toward live edge (${totalCorrectionMs.toFixed(1)} ms)`);
      }
    } else if (correction.mode === 'nudge') {
      applyPlaybackRateNudge(totalCorrectionMs);
      console.log(`[Sync] Nudged playback by ${totalCorrectionMs.toFixed(1)} ms`);
    }

    syncCortex.consensus.broadcastHeartbeat(actualPositionSec);

  }, 500); // Every 500ms for consensus

  // ── Progress bar ───────────────────────────────────────────────────────────
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

function restartPlaybackAtPosition(targetElapsedSec) {
  if (!currentAudioBuffer || !activeSource) return;
  const boundedOffset = Math.max(0, Math.min(targetElapsedSec, currentAudioBuffer.duration - 0.05));
  try { activeSource.stop(); } catch (_) {}
  startBufferedPlayback(currentAudioBuffer, audioCtx.currentTime + 0.02, boundedOffset);
  playbackStartedAt = performance.now() - (boundedOffset * 1000);
}

function jumpToLiveEdge(targetElapsedSec) {
  if (!currentAudioBuffer || !activeSource) return;
  const boundedOffset = Math.max(0, Math.min(targetElapsedSec, currentAudioBuffer.duration - 0.05));
  const restartAtCtx = audioCtx.currentTime + 0.06;
  try { activeSource.stop(); } catch (_) {}
  if (masterGain) {
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.setValueAtTime(remoteVolume, audioCtx.currentTime);
    masterGain.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + 0.03);
    masterGain.gain.setValueAtTime(0.0, restartAtCtx - 0.01);
    masterGain.gain.linearRampToValueAtTime(remoteVolume, restartAtCtx + 0.04);
  }
  startBufferedPlayback(currentAudioBuffer, restartAtCtx, boundedOffset);
  playbackStartedAt = performance.now() + ((restartAtCtx - audioCtx.currentTime) * 1000) - (boundedOffset * 1000);
  recoveryUntilPerf = performance.now() + 180;
}

function holdForLiveCatchUp(currentElapsedSec, holdMs) {
  if (!currentAudioBuffer || !activeSource) return;
  const boundedOffset = Math.max(0, Math.min(currentElapsedSec, currentAudioBuffer.duration - 0.05));
  const clampedHoldMs = Math.min(250, Math.max(40, holdMs));
  const restartAtCtx = audioCtx.currentTime + (clampedHoldMs / 1000);
  try { activeSource.stop(); } catch (_) {}
  if (masterGain) {
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.setValueAtTime(remoteVolume, audioCtx.currentTime);
    masterGain.gain.linearRampToValueAtTime(0.0, audioCtx.currentTime + 0.015);
    masterGain.gain.setValueAtTime(0.0, restartAtCtx - 0.01);
    masterGain.gain.linearRampToValueAtTime(remoteVolume, restartAtCtx + 0.03);
  }
  startBufferedPlayback(currentAudioBuffer, restartAtCtx, boundedOffset);
  playbackStartedAt = performance.now() + clampedHoldMs - (boundedOffset * 1000);
  recoveryUntilPerf = performance.now() + clampedHoldMs + 120;
}

function applyPlaybackRateNudge(totalCorrectionMs) {
  if (!activeSource) return;
  const direction = totalCorrectionMs > 0 ? -1 : 1;
  const magnitude = Math.min(0.015, Math.max(0.0025, Math.abs(totalCorrectionMs) / 8000));
  const rate = direction > 0 ? 1 + magnitude : 1 - magnitude;
  activeSource.playbackRate.value = rate;
  const token = Date.now() + 220;
  suppressRateResetUntil = token;
  setTimeout(() => {
    if (activeSource && suppressRateResetUntil === token) {
      activeSource.playbackRate.value = 1.0;
    }
  }, 220);
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
    ol.innerHTML = '<li class="queue-empty">Queue is empty — add some songs above!</li>';
    return;
  }

  ol.innerHTML = q.map((song) => `
    <li class="queue-item" data-id="${escHtml(song.id)}">
      <span class="queue-title">${escHtml(song.title)}</span>
      <span class="queue-dur">${formatDuration(song.duration)}</span>
      <div class="queue-actions">
        <button class="btn-rate" onclick="rateSong('${escHtml(song.id)}', 5)" title="Rate 5⭐">⭐</button>
        <button class="btn-fav ${window.favorites?.has(song.id) ? 'active' : ''}" onclick="toggleFav('${escHtml(song.id)}')" title="Favorite">♡</button>
        <button class="btn-remove" onclick="removeFromQueue('${escHtml(song.id)}')">✕</button>
      </div>
    </li>
  `).join('');
}

function renderHistory() {
  const histEl = document.getElementById('history-list');
  if (!histEl) return;
  
  const h = window.history || [];
  if (!h.length) {
    histEl.innerHTML = '<div class="history-empty">No history yet</div>';
    return;
  }

  histEl.innerHTML = h.slice(0, 20).map(song => `
    <div class="history-item">
      <div class="hist-title">${escHtml(song.title)}</div>
      <div class="hist-time">${new Date(song.playedAt).toLocaleTimeString()}</div>
      ${song.isFavorite ? '<span class="fav-badge">★</span>' : ''}
    </div>
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
  ensureAudioCtx(); // Unblock AudioContext on first user action
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

// ─── Feature 37: Vote-to-Skip ─────────────────────────────────────────────────
function voteSkip() {
  socket.emit('voteSkip');
  showStatus('info', 'Vote recorded!');
}

// ─── CUSTOM 2: Song Rating ────────────────────────────────────────────────────
function rateSong(songId, rating) {
  socket.emit('rateSong', { songId, rating });
}

// ─── Feature 39: Toggle Favorite ──────────────────────────────────────────────
function toggleFav(songId) {
  socket.emit('toggleFavorite', songId);
}

// Request history on load
function loadHistory() {
  socket.emit('getHistory');
  socket.emit('getFavorites');
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
