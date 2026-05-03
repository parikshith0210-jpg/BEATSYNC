# 🎵 BeatSync - Complete Feature Walkthrough

## **Table of Contents**
1. [Getting Started](#getting-started)
2. [Core Features](#core-features)
3. [Week 2+ Features](#week-2-features)
4. [Custom Features](#custom-features)
5. [Advanced Usage](#advanced-usage)

---

## **GETTING STARTED**

### **Step 1: Verify Server is Running**
```bash
cd d:\my-beatsync
npm start
```
You should see:
```
🎵 BeatSync is running!
   Local:   http://localhost:3000
   Network: http://192.168.0.102:3000  ← open this on all your devices
```

### **Step 2: Open on First Device**
Open `http://192.168.0.102:3000` in your browser (the IP shown above)

### **Step 3: Open on Second Device**
Open the same URL on another device (phone, tablet, etc.)
You'll see in the header: "2 devices" ✓

---

## **CORE FEATURES**

### **Feature: Add YouTube Video**

**What it does:** Download a single YouTube video and add to queue

**How to use:**
1. Paste any YouTube URL into the input box:
   ```
   https://www.youtube.com/watch?v=dQw4w9WgXcQ
   ```
2. Click "＋ Add"
3. Watch the status bar:
   - "Fetching metadata..." → Downloading info
   - "Downloaded: Song Title" → Ready to play

**Behind the scenes:**
- yt-dlp extracts video ID and metadata
- Audio is extracted to MP3 (192kbps quality)
- Saved as `/audio/{videoId}.mp3`
- Added to `queue.json`

---

### **Feature: Add YouTube Playlist**

**What it does:** Download entire playlist and queue all songs

**How to use:**
1. Paste a playlist URL:
   ```
   https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxx
   ```
2. Click "＋ Add"
3. Status shows: "Found 15 track(s). Queuing downloads..."
4. Songs appear in queue as they download

**Behind the scenes:**
- yt-dlp fetches metadata for all songs in playlist
- Downloads happen sequentially (not parallel) to avoid YouTube throttling
- Each song saves with its video ID as filename
- Sorted in queue by playlist order

---

### **Feature: Skip Current Song**

**What it does:** Stop playing current song, move to next

**How to use:**
1. While a song is playing, click "⏭ Skip"
2. Progress bar resets
3. Next song in queue starts playing

**Behind the scenes:**
- Server calls `nextSong()` immediately
- Stops any pending auto-advance timer
- Broadcasts new song to all clients
- All devices skip in sync

---

### **Feature: Remove Song from Queue**

**What it does:** Delete a song from the "Up Next" list

**How to use:**
1. Find the song in "Up Next" section
2. Click the "✕" button next to it
3. Song disappears from queue and `queue.json`

**Behind the scenes:**
- Server removes song by ID from queue array
- Saves to `queue.json`
- Broadcasts updated queue to all clients

---

### **Feature: Live Sync Across Devices**

**What it does:** Play the exact same song at the exact same time on all devices

**How it works:**
1. Server picks a future time: `startTime = Date.now() + 3000` (3 seconds)
2. Broadcasts `startTime` to all devices
3. Each client calculates local clock offset (via 20-ping calibration)
4. Web Audio API schedules playback for exactly that time
5. Micro-drift correction keeps devices within ±2ms of each other

**Performance:**
- Sync accuracy: ±1-2ms
- Network latency handled automatically
- Drift corrects inaudibly (playback rate tweaks)

**Visible indicators:**
- Green "✓ Synced" badge in header
- Device count shows connected devices
- Network RTT badge shows connection quality

---

## **WEEK 2+ FEATURES**

### **Feature 37: Vote-to-Skip** 🎯

**What it does:** Require majority of devices to agree before skipping

**How to use:**
1. Click "Vote Skip" button (showing "current/needed")
2. If you have 3 devices:
   - Device 1 votes: "1/2"
   - Device 2 votes: "2/2" → **Skip triggers!**
3. Song skips on all devices

**Behind the scenes:**
- `skipVotes` Map tracks which socket IDs voted
- Need = ceil(devices.size / 2)
- When threshold Met, all votes clear and `nextSong()` runs
- Broadcast `skipVotes` event shows progress to all clients

**Use case:** Prevent accidental skips when multiple people are listening

---

### **Feature 38: Song History** 📜

**What it does:** Track every song you've played with timestamps

**How to use:**
1. Scroll to "Recently Played" section at bottom
2. See last 20 songs with:
   - **Song title**
   - **Time played** (HH:MM:SS format)
   - **★ badge** if marked as favorite

**Example display:**
```
Recently Played
───────────────
Blinding Lights        10:42:30  ★
The Weeknd            10:39:15
Levitating            10:35:22  ★
(etc...)
```

**Behind the scenes:**
- Every time `nextSong()` runs, current song added to `history` array
- Sorted newest first (unshift)
- Kept to last 100 songs
- Saved to `history.json`
- Persists between server restarts

**Export history:**
```bash
curl http://localhost:3000/api/export/history > my-history.json
```

---

### **Feature 39: Favorites System** ♡

**What it does:** Mark favorite songs and build curated lists

**How to use:**
1. In "Up Next" queue, click the ♡ button next to any song
2. Button fills in green (★ = favorited)
3. Song appears with red ★ in history
4. Favorites saved to `favorites.json`

**View favorites:**
```bash
# Export top-rated (4+ star) songs as M3U
curl http://localhost:3000/api/export/top-rated > favorites.m3u

# Open in any audio player (Spotify, VLC, etc.)
```

**Behind the scenes:**
- Socket event `toggleFavorite` adds/removes ID from Set
- Broadcast `favoritesUpdate` to all clients
- Persisted to `favorites.json`
- No limit on number of favorites

---

### **Feature 40: REST API** 🔌

**What it does:** Control BeatSync programmatically

#### **GET /api/stats** - Server Health
```bash
curl http://localhost:3000/api/stats | jq .

# Output:
{
  "uptime": 3642.5,
  "queueLength": 12,
  "currentSong": "Blinding Lights",
  "connectedDevices": 3,
  "totalFavorites": 7,
  "historyLength": 42,
  "avgNetworkRTT": "12.3"
}
```

#### **GET /api/queue** - Current Queue
```bash
curl http://localhost:3000/api/queue | jq .

# Output:
{
  "queue": [
    { "id": "abc123", "title": "Song 1", "duration": 240, "filename": "abc123.mp3" },
    { "id": "def456", "title": "Song 2", "duration": 180, "filename": "def456.mp3" }
  ],
  "currentSong": { "id": "xyz789", "title": "Now Playing", ... },
  "startTime": 1715000000000
}
```

#### **POST /api/add** - Add Song
```bash
curl -X POST http://localhost:3000/api/add \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'

# Output: { "status": "Added to queue" }
```

#### **POST /api/skip** - Skip
```bash
curl -X POST http://localhost:3000/api/skip

# Output: { "status": "Skipped" }
```

#### **GET /api/export/history** - Export Play History
```bash
curl http://localhost:3000/api/export/history > history.json

# Output: JSON array of last 100 songs
```

#### **GET /api/export/top-rated** - Export Favorites as M3U
```bash
curl http://localhost:3000/api/export/top-rated > favorites.m3u

# Output: Playlist file that plays all 4+ star songs
```

---

## **CUSTOM FEATURES**

### **CUSTOM 1: Smart Resume with Song Statistics** 📊

**What it does:** Track play count and last-played time for each song

**Visible in:**
- Re-add playlist: Songs show "last played X hours ago"
- Future: Smart queue recommendations
- HTTP API: `GET /api/stats`

**Behind the scenes:**
- `songStats` Map with entries: `{ songId: { lastPlayed, playCount } }`
- Updated every time `nextSong()` plays a song
- Persisted to `song-stats.json`
- Broadcast on reconnect

**Use cases:**
1. **Resume Smart Playlists**: "Continue playlist from 2 hours ago"
2. **Identify Favorites**: "Songs played 20+ times"
3. **Vacation Mode**: "Shuffle songs played >1 month ago"

---

### **CUSTOM 2: Song Rating System (1-5 Stars)** ⭐

**What it does:** Rate songs 1-5 stars and curate playlists automatically

**How to use:**
1. In queue, click ⭐ button
2. Song rated 5 stars
3. All clients notified of rating in real-time

**View/Export ratings:**

Via UI:
- History shows ★ badges for rated songs
- Favorites section curates 4+ star songs

Via API:
```bash
# Export all 4+ star songs as M3U playlist
curl http://localhost:3000/api/export/top-rated > my-favorites.m3u

# Open in any audio player
```

**Behind the scenes:**
- `songRatings` Map: `{ songId: 1-5 }`
- Persisted to `ratings.json`
- Broadcast `ratingsUpdate` to all clients
- Used to auto-populate "Top Rated" playlist

**Use cases:**
1. **Build Curated Playlists**: Export top-rated monthly
2. **Discover Favorites**: See which songs have highest ratings
3. **Replay Best**: Put 5-star playlist back in queue
4. **A/B Test Music**: Rate songs on different moods/times

---

### **CUSTOM 3: Network Quality Indicator** 📶

**What it does:** Show real-time network health and RTT

**Where you see it:**
- Golden badge in header: "GOOD (12ms)" / "FAIR (65ms)" / "POOR (105ms)"
- Color-coded:
  - 🟢 **GOOD** = RTT < 50ms (perfect sync)
  - 🟡 **FAIR** = RTT 50-100ms (acceptable)
  - 🔴 **POOR** = RTT > 100ms (consider WiFi improvement)

**How it works:**
- Every 10 seconds, client measures RTT to server
- Web Audio API measures time to receive `serverTime` response
- Server tracks rolling 20-sample average
- Broadcasts `networkQuality` event

**Behind the scenes:**
```javascript
// Client reports to server
socket.emit('reportRTT', rtt);

// Server calculates
networkMetrics.samples.push(rtt);
networkMetrics.avgRTT = samples.reduce((a,b) => a+b) / samples.length;

// Broadcast back
socket.emit('networkQuality', { quality, rtt: '12.3ms' });
```

**Use cases:**
1. **Diagnose Sync Issues**: If poor, suggests network problem
2. **Optimize Device Placement**: "Move closer to WiFi router"
3. **Identify Bottleneck**: "Wired vs WiFi comparison"
4. **Future Enhancement**: Auto-switch to lower bitrate on poor networks

---

## **ADVANCED USAGE**

### **Automation: Hourly Playlist Rotation**

```bash
#!/bin/bash
# Add a new playlist every hour

while true; do
  curl -X POST http://localhost:3000/api/add \
    -H "Content-Type: application/json" \
    -d '{"url": "https://www.youtube.com/playlist?list=PLxxxx"}'
  sleep 3600
done
```

### **Backup: Weekly State Export**

```bash
#!/bin/bash
# Backup all state every Sunday

BACKUP_DIR="/mnt/backups/beatsync"
mkdir -p "$BACKUP_DIR"

tar -czf "$BACKUP_DIR/backup-$(date +%Y%m%d-%H%M%S).tar.gz" \
  *.json audio/
```

### **Monitoring: Real-time Server Stats**

```bash
#!/bin/bash
# Check stats every 30 seconds

watch -n 30 'curl -s http://localhost:3000/api/stats | jq .'
```

### **Integration: Add Song from Command Line**

```bash
#!/bin/bash
# Add a song from terminal

beatsync_add() {
  curl -s -X POST http://localhost:3000/api/add \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$1\"}" | jq .message
}

# Usage:
beatsync_add "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

---

## **🎉 YOU'RE ALL SET!**

You now know how to use every feature in BeatSync. Start with:
1. Add a playlist
2. Open on 2+ devices
3. Watch them sync perfectly 🎵

Enjoy perfectly synced music across your whole house!
