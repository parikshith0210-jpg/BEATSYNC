# 🎵 BeatSync Personal

A local-network music sync app — play the same song on all your devices simultaneously with sub-5ms precision.

---

## Prerequisites

### 1. Node.js
Download from https://nodejs.org (v18+ recommended)

### 2. yt-dlp
Used to download YouTube audio. Install once:

| Platform | Command |
|----------|---------|
| **Windows** | `winget install yt-dlp` OR `choco install yt-dlp` |
| **Mac** | `brew install yt-dlp` |
| **Linux** | `sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp` |

If you installed `yt-dlp` through Python, make sure `python`, `python3`, or `py` is on your PATH.

On Android, make sure your phone is on the same Wi-Fi network as your PC and that the network does not isolate devices from each other.
If the browser remains silent, tap the page once to unlock audio playback.

If the page does not load at all from your phone, check Windows Firewall and allow Node.js or port 3000 for private network access.

Verify it works: `yt-dlp --version`

---

## Setup & Run

```bash
# 1. Install Node dependencies (only needed once)
npm install

# 2. Start the server
npm start
```

You'll see output like:
```
🎵 BeatSync is running!
   Local:   http://localhost:3000
   Network: http://192.168.1.42:3000  ← open this on all your devices
```

Open the **Network URL** on every phone, tablet, or PC on your Wi-Fi.

---

## Usage

1. **Add music** — Paste any YouTube video or playlist URL into the input and click **Add**.
   - The server will download the audio in the background (progress shown in the status bar).
   - Songs are added to the queue automatically.

2. **Playback starts automatically** when the first song is downloaded.

3. **Skip** — Use the Skip button to jump to the next song.

4. **Remove from queue** — Click the ✕ button on any queued song.

---

## How Sync Works

- **Clock calibration**: On connect, each device sends 20 rapid pings to measure the exact time difference between its clock and the server (usually within 1–2 ms on LAN).
- **Future scheduling**: When a song starts, the server picks a timestamp 3 seconds in the future and broadcasts it to all devices. All devices schedule playback at that exact moment using the Web Audio API.
- **Drift correction**: Every second, each device checks if its playback position has drifted. If drift > 5 ms, it nudges the playback rate by ±1% for 500 ms — completely inaudible but keeps everything locked in sync.

---

## Folder Structure

```
my-beatsync/
├── server.js          ← Node.js server
├── package.json
├── README.md
├── audio/             ← Downloaded MP3s (auto-created)
└── public/
    ├── index.html
    ├── client.js      ← Sync logic + UI
    └── style.css
```

---

## Tips

- **All devices must be on the same Wi-Fi network** as the computer running the server.
- Audio files are stored in the `audio/` folder. You can delete them to free up space.
- The queue and audio are lost when the server restarts (in-memory only).
- For large playlists, wait for the status bar to confirm each song is downloaded before playing.
