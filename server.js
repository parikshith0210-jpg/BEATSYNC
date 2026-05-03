const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const YTDlpWrap = require('yt-dlp-wrap').default;

function findExecutable(name) {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `command -v ${name}`;
    const result = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return result.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function resolveYtDlpRunner() {
  const direct = findExecutable('yt-dlp') || findExecutable('yt_dlp');
  if (direct) return { binary: direct, prefixArgs: [], source: 'binary' };

  const python = findExecutable('python') || findExecutable('python3') || findExecutable('py');
  if (python) {
    const base = path.basename(python).toLowerCase();
    const isPyLauncher = base === 'py' || base === 'py.exe';
    const prefixArgs = isPyLauncher ? ['-3', '-m', 'yt_dlp'] : ['-m', 'yt_dlp'];
    return { binary: python, prefixArgs, source: 'python-module' };
  }

  return null;
}

function getYtDlpUnavailableMessage() {
  return [
    'yt-dlp is not available.',
    process.platform === 'win32'
      ? 'Install it with: `py -3 -m pip install -U yt-dlp` or install the standalone `yt-dlp.exe` and add it to PATH.'
      : 'Install it with your package manager or `python3 -m pip install -U yt-dlp`.'
  ].join(' ');
}

function verifyYtDlpRunner(runner) {
  if (!runner) {
    return { ready: false, message: getYtDlpUnavailableMessage() };
  }

  try {
    execSync(`"${runner.binary}" ${[...runner.prefixArgs, '--version'].join(' ')}`, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ready: true, message: '' };
  } catch (err) {
    const stderr = err?.stderr?.toString().trim();
    const stdout = err?.stdout?.toString().trim();
    const details = stderr || stdout || err.message;
    return {
      ready: false,
      message: `${getYtDlpUnavailableMessage()} Details: ${details}`
    };
  }
}

const ytDlpRunner = resolveYtDlpRunner();
const ytDlpStatus = verifyYtDlpRunner(ytDlpRunner);
if (!ytDlpStatus.ready) {
  console.warn(`\n[Startup] ${ytDlpStatus.message}`);
}

const ytDlp = ytDlpRunner ? new YTDlpWrap(ytDlpRunner.binary) : null;

function ytDlpArgs(args) {
  if (!ytDlpRunner) return args;
  return [...ytDlpRunner.prefixArgs, ...args];
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve frontend and audio files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));

// Ensure audio directory exists
const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

const queueFile = path.join(__dirname, 'queue.json');

function loadQueue() {
  if (!fs.existsSync(queueFile)) return [];
  try {
    return JSON.parse(fs.readFileSync(queueFile, 'utf8')) || [];
  } catch (err) {
    console.warn('[Queue] Failed to parse queue.json, starting fresh.', err.message);
    return [];
  }
}

function saveQueue() {
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
}

function getSongAudioPath(song) {
  if (!song || typeof song.filename !== 'string' || !song.filename.trim()) return null;
  return path.join(audioDir, song.filename);
}

function hasAudioFile(song) {
  const audioPath = getSongAudioPath(song);
  return Boolean(audioPath && fs.existsSync(audioPath));
}

function sanitizeQueueEntries(entries, context = 'Queue') {
  const valid = [];
  const removed = [];

  for (const song of Array.isArray(entries) ? entries : []) {
    if (hasAudioFile(song)) {
      valid.push(song);
    } else {
      removed.push(song);
    }
  }

  if (removed.length > 0) {
    const names = removed.map((song) => song?.title || song?.filename || song?.id || 'unknown').join(', ');
    console.warn(`[${context}] Removed ${removed.length} missing audio entr${removed.length === 1 ? 'y' : 'ies'}: ${names}`);
  }

  return { valid, removed };
}

// ─── Global State ─────────────────────────────────────────────────────────────
let queue = loadQueue(); // [{ id, title, duration, filename }]
const initialQueueCheck = sanitizeQueueEntries(queue, 'Startup');
queue = initialQueueCheck.valid;
if (initialQueueCheck.removed.length > 0) saveQueue();
let currentSong = null;
let startTime = null;   // server unix ms when the current song starts
let autoAdvanceTimer = null;
let devices = new Set();
let syncAnchorId = null;
let globalVolume = 1.0;
let downloadJobs = [];
let isDownloading = false;

// ─── WEEK 2+ ENHANCEMENTS ─────────────────────────────────────────────────────
// Feature 37: Vote-to-skip
let skipVotes = new Map();
const votesNeededToSkip = () => Math.ceil(devices.size / 2);

// Feature 38: Song history tracking
let history = [];
const historyFile = path.join(__dirname, 'history.json');
function loadHistory() {
  return fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : [];
}
history = loadHistory();

// Feature 39: Favorites system
let favorites = new Set();
const favoritesFile = path.join(__dirname, 'favorites.json');
function loadFavorites() {
  return fs.existsSync(favoritesFile) ? new Set(JSON.parse(fs.readFileSync(favoritesFile))) : new Set();
}
favorites = loadFavorites();

// CUSTOM FEATURE 1: Last-played tracking for smart resume
let songStats = new Map();
const statsFile = path.join(__dirname, 'song-stats.json');
function loadStats() {
  try {
    const data = JSON.parse(fs.readFileSync(statsFile));
    return new Map(data);
  } catch {
    return new Map();
  }
}
songStats = loadStats();

// CUSTOM FEATURE 2: Song rating system (1-5 stars)
let songRatings = new Map();
const ratingsFile = path.join(__dirname, 'ratings.json');
function loadRatings() {
  try {
    const data = JSON.parse(fs.readFileSync(ratingsFile));
    return new Map(data);
  } catch {
    return new Map();
  }
}
songRatings = loadRatings();

// CUSTOM FEATURE 3: Network quality tracking
let networkMetrics = {
  avgRTT: 0,
  jitter: 0,
  samples: []
};

function saveFavorites() {
  fs.writeFileSync(favoritesFile, JSON.stringify([...favorites]));
}

function saveHistory() {
  fs.writeFileSync(historyFile, JSON.stringify(history.slice(0, 100)));
}

function saveStats() {
  fs.writeFileSync(statsFile, JSON.stringify([...songStats]));
}

function saveRatings() {
  fs.writeFileSync(ratingsFile, JSON.stringify([...songRatings]));
}

function getCurrentSyncAnchorId() {
  if (syncAnchorId && devices.has(syncAnchorId)) return syncAnchorId;
  syncAnchorId = devices.values().next().value || null;
  return syncAnchorId;
}

function emitSyncRoles(targetSocket = null) {
  const anchorId = getCurrentSyncAnchorId();
  const payload = {
    anchorDeviceId: anchorId,
    role: targetSocket && targetSocket.id === anchorId ? 'anchor' : 'peer'
  };
  if (targetSocket) {
    targetSocket.emit('syncRole', payload);
    return;
  }
  for (const socket of io.sockets.sockets.values()) {
    socket.emit('syncRole', {
      anchorDeviceId: anchorId,
      role: socket.id === anchorId ? 'anchor' : 'peer'
    });
  }
}

// ─── WebSocket Handlers ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Device connected: ${socket.id}`);
  devices.add(socket.id);
  getCurrentSyncAnchorId();
  io.emit('deviceCount', devices.size);
  emitSyncRoles();

  // Send full current state to the newly connected device immediately
  socket.emit('state', { queue, currentSong, startTime, globalVolume });

  // ── Time sync: client sends its timestamp, server echoes back NOW ──────────
  socket.on('getServerTime', () => {
    socket.emit('serverTime', Date.now());
  });

  socket.on('requestState', () => {
    socket.emit('state', { queue, currentSong, startTime, globalVolume });
  });

  // ── Add a YouTube video or playlist URL ───────────────────────────────────
  socket.on('addYoutube', async (url) => {
    console.log(`[YouTube] Adding: ${url}`);

    if (!ytDlpStatus.ready || !ytDlp) {
      socket.emit('status', { type: 'error', message: ytDlpStatus.message });
      return;
    }

    socket.emit('status', { type: 'info', message: `Fetching metadata for: ${url}` });

    try {
      // Fetch metadata (handles both single videos and playlists)
      const info = await ytDlp.execPromise(ytDlpArgs([url, '--flat-playlist', '-j']));
      const lines = info.trim().split('\n').filter(Boolean);

      socket.emit('status', { type: 'info', message: `Found ${lines.length} track(s). Queuing downloads...` });

      for (const line of lines) {
        let data;
        try { data = JSON.parse(line); } catch { continue; }

        const videoId = data.id;
        const videoUrl = data.url || data.webpage_url || `https://www.youtube.com/watch?v=${videoId}`;
        const filename = `${videoId}.mp3`;
        const outputPath = path.join(audioDir, filename);

        if (queue.some((song) => song.id === videoId) || currentSong?.id === videoId) {
          socket.emit('status', { type: 'info', message: `Already queued: ${data.title || videoId}` });
          continue;
        }

        const song = {
          id: videoId,
          title: data.title || data.title || videoId,
          duration: data.duration || 0,
          filename
        };

        if (fs.existsSync(outputPath)) {
          queue.push(song);
          saveQueue();
          io.emit('queueUpdate', queue);
          socket.emit('status', { type: 'success', message: `Queued existing file: ${song.title}` });
          continue;
        }

        downloadJobs.push({ videoUrl, outputPath, song, socketId: socket.id });
        socket.emit('status', { type: 'info', message: `Queued download: ${song.title}` });
      }

      processDownloads();

      // Auto-start if nothing is playing and we already have queue items ready
      if (!currentSong && queue.length > 0) nextSong();

    } catch (err) {
      console.error('[YouTube Error]', err.message);
      socket.emit('status', { type: 'error', message: `Error: ${err.message}` });
    }
  });

  // ── Skip current song ──────────────────────────────────────────────────────
  socket.on('skip', () => {
    console.log('[Skip] Skipping current song');
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    nextSong();
  });

  // ── Remove a specific song from queue ──────────────────────────────────────
  socket.on('removeFromQueue', (songId) => {
    queue = queue.filter((s) => s.id !== songId);
    saveQueue();
    io.emit('queueUpdate', queue);
  });

  // ── Reorder queue (drag and drop support) ──────────────────────────────────
  socket.on('reorderQueue', (newQueue) => {
    queue = sanitizeQueueEntries(newQueue, 'Reorder').valid;
    saveQueue();
    io.emit('queueUpdate', queue);
  });

  socket.on('setGlobalVolume', (vol) => {
    const volume = Number(vol);
    if (Number.isFinite(volume) && volume >= 0 && volume <= 1) {
      globalVolume = volume;
      io.emit('globalVolume', globalVolume);
    }
  });

  socket.on('disconnect', () => {
    devices.delete(socket.id);
    skipVotes.delete(socket.id);
    if (socket.id === syncAnchorId) syncAnchorId = null;
    getCurrentSyncAnchorId();
    io.emit('deviceCount', devices.size);
    emitSyncRoles();
    console.log(`[-] Device disconnected: ${socket.id}`);
  });

  // ─── Feature 37: Vote-to-Skip ─────────────────────────────────────────────
  socket.on('voteSkip', () => {
    skipVotes.set(socket.id, true);
    const needed = votesNeededToSkip();
    const current = skipVotes.size;
    io.emit('skipVotes', { current, needed });
    if (current >= needed) {
      console.log(`[Vote Skip] ${current}/${needed} votes reached!`);
      skipVotes.clear();
      socket.emit('status', { type: 'success', message: 'Skip voting passed! ✓' });
      if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
      nextSong();
    } else {
      socket.emit('status', { type: 'info', message: `Vote recorded (${current}/${needed})` });
    }
  });

  // ─── Feature 38: Get Song History ─────────────────────────────────────────
  socket.on('getHistory', () => {
    socket.emit('history', history);
  });

  // ─── Feature 39: Favorites Management ─────────────────────────────────────
  socket.on('toggleFavorite', (songId) => {
    if (favorites.has(songId)) {
      favorites.delete(songId);
      socket.emit('status', { type: 'info', message: 'Removed from favorites' });
    } else {
      favorites.add(songId);
      socket.emit('status', { type: 'success', message: 'Added to favorites ★' });
    }
    saveFavorites();
    io.emit('favoritesUpdate', [...favorites]);
  });

  socket.on('getFavorites', () => {
    socket.emit('favorites', [...favorites]);
  });

  // ─── Advanced Sync: Heartbeat Relay ───────────────────────────────────────
  socket.on('heartbeat', (data) => {
    // Relay heartbeat to all other devices for consensus
    socket.broadcast.emit('heartbeat', data);
  });

  // ─── Advanced Sync: Biorhythm Phase Relay ────────────────────────────────

  // ─── Advanced Sync: Request Beat Lattice ──────────────────────────────────
  socket.on('requestBeatLattice', () => {
    if (currentSong && startTime) {
      const bpm = 128; // Assume default BPM, could be extracted from song metadata
      const lattice = {
        startTime,
        bpm,
        beats: generateBeatSequence(1000, startTime, bpm)
      };
      socket.emit('beatLattice', lattice);
    }
  });

  // Helper function for beat lattice
  function generateBeatSequence(count, startTime, bpm) {
    const interval = 60000 / bpm; // ms per beat
    const beats = [];
    for (let i = 0; i < count; i++) {
      beats.push(startTime + i * interval);
    }
    return beats;
  }

  // ─── CUSTOM 1: Smart Resume (last-played tracking) ────────────────────────
  socket.on('recordPlayback', (songId) => {
    const now = Date.now();
    if (!songStats.has(songId)) songStats.set(songId, {});
    const stat = songStats.get(songId);
    stat.lastPlayed = now;
    stat.playCount = (stat.playCount || 0) + 1;
    saveStats();
  });

  socket.on('getLastPlayed', () => {
    socket.emit('lastPlayed', Object.fromEntries(songStats));
  });

  // ─── CUSTOM 2: Song Rating System (1-5 stars) ───────────────────────────
  socket.on('rateSong', ({ songId, rating }) => {
    if (rating >= 1 && rating <= 5) {
      songRatings.set(songId, rating);
      saveRatings();
      socket.emit('status', { type: 'success', message: `Rated: ${rating} ⭐` });
      io.emit('ratingsUpdate', Object.fromEntries(songRatings));
    }
  });

  socket.on('getTopRated', () => {
    const topSongs = queue
      .filter(s => songRatings.has(s.id))
      .sort((a, b) => (songRatings.get(b.id) || 0) - (songRatings.get(a.id) || 0))
      .slice(0, 10);
    socket.emit('topRated', topSongs);
  });

  // ─── CUSTOM 3: Network Metrics (for bit-rate adaptation) ────────────────
  socket.on('reportRTT', (rtt) => {
    networkMetrics.samples.push(rtt);
    if (networkMetrics.samples.length > 20) networkMetrics.samples.shift();
    networkMetrics.avgRTT = networkMetrics.samples.reduce((a, b) => a + b, 0) / networkMetrics.samples.length;
    const variance = networkMetrics.samples.reduce((sum, sample) => sum + Math.pow(sample - networkMetrics.avgRTT, 2), 0) / networkMetrics.samples.length;
    networkMetrics.jitter = Math.sqrt(variance);
    
    // Determine quality based on RTT
    let quality = 'good';
    if (networkMetrics.avgRTT > 50) quality = 'fair';
    if (networkMetrics.avgRTT > 100) quality = 'poor';
    let profile = 'lan';
    if (networkMetrics.avgRTT > 25 || networkMetrics.jitter > 8) profile = 'stable-wifi';
    if (networkMetrics.avgRTT > 70 || networkMetrics.jitter > 20) profile = 'weak-wifi';
    socket.emit('networkQuality', {
      quality,
      profile,
      rtt: networkMetrics.avgRTT.toFixed(1),
      jitter: networkMetrics.jitter.toFixed(1)
    });
  });
});

// ─── Download Queue ──────────────────────────────────────────────────────────
async function processDownloads() {
  if (isDownloading || downloadJobs.length === 0) return;
  if (!ytDlpStatus.ready || !ytDlp) {
    console.warn(`[Downloads] ${ytDlpStatus.message}`);
    downloadJobs = [];
    return;
  }
  isDownloading = true;

  const job = downloadJobs.shift();
  const { videoUrl, outputPath, song, socketId } = job;
  const emitter = io.sockets.sockets.get(socketId);
  try {
    if (!fs.existsSync(outputPath)) {
      await ytDlp.execPromise(ytDlpArgs([
        videoUrl,
        '-x', '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-o', outputPath
      ]));
    }

    queue.push(song);
    saveQueue();
    io.emit('queueUpdate', queue);
    emitter?.emit('status', { type: 'success', message: `Downloaded: ${song.title}` });
    if (!currentSong) nextSong();
  } catch (err) {
    console.error(`[Download Error] ${song.title}:`, err.message);
    emitter?.emit('status', { type: 'error', message: `Download failed: ${song.title}` });
  } finally {
    isDownloading = false;
    processDownloads();
  }
}

// ─── Core Playback Logic ──────────────────────────────────────────────────────
function nextSong() {
  queue = sanitizeQueueEntries(queue, 'Playback').valid;
  saveQueue();

  if (queue.length === 0) {
    currentSong = null;
    startTime = null;
    saveQueue();
    io.emit('state', { queue, currentSong, startTime, globalVolume });
    console.log('[Queue] Empty — waiting for songs.');
    return;
  }

  currentSong = null;
  while (queue.length > 0 && !currentSong) {
    const candidate = queue.shift();
    if (hasAudioFile(candidate)) {
      currentSong = candidate;
    } else {
      console.warn(`[Playback] Skipping missing audio file for "${candidate?.title || candidate?.filename || candidate?.id || 'unknown'}"`);
    }
  }
  saveQueue();

  if (!currentSong) {
    startTime = null;
    io.emit('state', { queue, currentSong, startTime, globalVolume });
    console.log('[Queue] No playable audio files remain.');
    return;
  }

  startTime = Date.now() + 3000; // 3-second lead so all devices can buffer

  // Feature 38: Track play history
  if (currentSong) {
    history.unshift({
      ...currentSong,
      playedAt: Date.now(),
      rating: songRatings.get(currentSong.id) || 0,
      isFavorite: favorites.has(currentSong.id)
    });
    if (history.length > 100) history.pop();
    saveHistory();
  }

  console.log(`[Now Playing] "${currentSong.title}" (starts at ${new Date(startTime).toISOString()})`);

  io.emit('state', { queue, currentSong, startTime, globalVolume, favorites: [...favorites] });
  io.emit('queueUpdate', queue);
  io.emit('history', history);

  // Auto-advance to next song when this one ends
  const songDurationMs = (currentSong.duration || 0) * 1000;
  const delay = songDurationMs + 3000 + 500; // include the lead time plus a small buffer
  if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
  autoAdvanceTimer = setTimeout(nextSong, delay);
}

// ─── REST API Endpoints ───────────────────────────────────────────────────────
// Feature 40 (REST API): Expose song operations via HTTP

app.get('/api/queue', (req, res) => {
  res.json({ queue, currentSong, startTime });
});

app.post('/api/add', express.json(), (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  // Emit as if a socket sent it (we'll broadcast to socket #1 for simplicity)
  io.emit('incomingAdd', url);
  res.json({ status: 'Added to queue', url });
});

app.post('/api/skip', (req, res) => {
  if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
  nextSong();
  res.json({ status: 'Skipped' });
});

// Feature 39 Extended: Export top-rated songs as M3U playlist
app.get('/api/export/top-rated', (req, res) => {
  const topSongs = queue
    .filter(s => (songRatings.get(s.id) || 0) >= 4)
    .map(s => `/audio/${s.filename}`)
    .join('\n');
  res.type('text/plain');
  res.send(`#EXTM3U\n${topSongs}`);
});

// Feature 38 Extended: Export history as JSON
app.get('/api/export/history', (req, res) => {
  res.json(history);
});

// Health check & stats endpoint
app.get('/api/stats', (req, res) => {
  res.json({
    uptime: process.uptime(),
    queueLength: queue.length,
    currentSong: currentSong?.title || null,
    connectedDevices: devices.size,
    totalFavorites: favorites.size,
    historyLength: history.length,
    avgNetworkRTT: networkMetrics.avgRTT.toFixed(1)
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Saving state and exiting...');
  saveQueue();
  saveFavorites();
  saveHistory();
  saveStats();
  saveRatings();
  process.exit(0);
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }

  console.log('\n🎵 BeatSync is running!');
  console.log(`   Local:   http://localhost:${PORT}`);
  if (addresses.length > 0) {
    console.log('   Network:');
    for (const addr of addresses) {
      console.log(`      http://${addr}:${PORT}`);
    }
  } else {
    console.log('   Network: no LAN address detected');
  }
  console.log('   Note: allow port 3000 / Node.js through Windows Firewall if the page fails to load from another device.');
  console.log('');

  if (!currentSong && queue.length > 0) {
    console.log('[Queue] Restored saved queue and will start playback now.');
    nextSong();
  }
});
