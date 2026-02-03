const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const app = express();

app.use(cors());
app.use(express.json());

const sessions = {};

// Helper to ensure HTTPS for external image URLs
function ensureHttps(url) {
  if (!url) return url;
  return url.replace(/^http:\/\//, 'https://');
}

// ========== HISTORY SYSTEM ==========
// Use data directory if it exists (for Docker), otherwise use current directory
const DATA_DIR = fs.existsSync(path.join(__dirname, "data")) 
  ? path.join(__dirname, "data") 
  : __dirname;
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const MAX_HISTORY_ITEMS = 50; // Keep last 50 tracks

// Load history from disk on startup
let history = [];
try {
  if (fs.existsSync(HISTORY_FILE)) {
    const data = fs.readFileSync(HISTORY_FILE, "utf8");
    history = JSON.parse(data);
    console.log(`📚 Loaded ${history.length} tracks from history`);
  }
} catch (err) {
  console.log("⚠️ Could not load history file, starting fresh:", err.message);
  history = [];
}

// Save history to disk
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to save history:", err.message);
  }
}

// Add track to history
function addToHistory(trackData) {
  const { song, artist, album, albumArt, app, duration, user, genre, year, label, artistImage } = trackData;
  
  if (!song || !artist) return;
  
  const trackId = `${song.toLowerCase()}-${artist.toLowerCase()}`;
  
  // Remove if already exists (we'll re-add at top)
  history = history.filter(t => t.id !== trackId);
  
  // Add to beginning
  history.unshift({
    id: trackId,
    song,
    artist,
    album: album || "",
    albumArt: ensureHttps(albumArt) || "",
    app: app || "Unknown",
    duration: duration || 0,
    playedAt: Date.now(),
    playCount: (history.find(t => t.id === trackId)?.playCount || 0) + 1,
    // Include user info in history
    user: user ? {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
    } : null,
    // Extended metadata from Gemini AI
    genre: genre || null,
    year: year || null,
    label: label || null,
    artistImage: ensureHttps(artistImage) || null
  });
  
  // Trim to max size
  history = history.slice(0, MAX_HISTORY_ITEMS);
  
  // Save to disk
  saveHistory();
  
  console.log(`📝 Added to history: ${song} - ${artist}${user ? ` (${user.displayName})` : ''}${genre ? ` [${genre}]` : ''}`);
}

// ========== HISTORY ENDPOINTS ==========

// GET recently played tracks
app.get("/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, MAX_HISTORY_ITEMS);
  
  res.json({
    count: Math.min(history.length, limit),
    total: history.length,
    tracks: history.slice(0, limit)
  });
});

// GET recently played for a specific session (useful for session-specific views)
app.get("/history/session/:sessionId", (req, res) => {
  const session = sessions[req.params.sessionId];
  
  if (!session) {
    // Return global history if session not found
    const limit = Math.min(parseInt(req.query.limit) || 10, MAX_HISTORY_ITEMS);
    return res.json({
      count: Math.min(history.length, limit),
      total: history.length,
      tracks: history.slice(0, limit)
    });
  }
  
  // Filter history by app if session is active
  const limit = Math.min(parseInt(req.query.limit) || 10, MAX_HISTORY_ITEMS);
  const appHistory = history.filter(t => t.app === session.app).slice(0, limit);
  
  res.json({
    count: appHistory.length,
    total: history.filter(t => t.app === session.app).length,
    app: session.app,
    tracks: appHistory
  });
});

// GET history for a specific user
app.get("/history/user/:userId", (req, res) => {
  const userId = req.params.userId;
  const limit = Math.min(parseInt(req.query.limit) || 10, MAX_HISTORY_ITEMS);
  
  const userHistory = history.filter(t => t.user?.id === userId).slice(0, limit);
  
  res.json({
    count: userHistory.length,
    total: history.filter(t => t.user?.id === userId).length,
    userId: userId,
    tracks: userHistory
  });
});

// DELETE history (clear all)
app.delete("/history", (req, res) => {
  const count = history.length;
  history = [];
  saveHistory();
  
  console.log(`🗑️ Cleared ${count} tracks from history`);
  res.json({ success: true, cleared: count });
});

// DELETE specific track from history
app.delete("/history/:trackId", (req, res) => {
  const trackId = req.params.trackId;
  const initialLength = history.length;
  
  history = history.filter(t => t.id !== trackId);
  
  if (history.length < initialLength) {
    saveHistory();
    res.json({ success: true, message: "Track removed from history" });
  } else {
    res.status(404).json({ error: "Track not found in history" });
  }
});

// ========== SESSION MANAGEMENT ==========

// Cleanup old inactive sessions and really stale active sessions
setInterval(() => {
  const now = Date.now();
  Object.keys(sessions).forEach(id => {
    const session = sessions[id];

    // Delete inactive sessions older than 1 hour
    if (!session.active && now - session.createdAt > 3600000) {
      console.log(`🗑️ Deleting old inactive session: ${id}`);
      delete sessions[id];
    }
    // Delete active sessions that haven't been updated in 6 hours (really stale)
    else if (session.active && now - session.lastUpdated > 21600000) {
      console.log(`🗑️ Deleting stale active session: ${id} (no updates for 6 hours)`);
      delete sessions[id];
    }
  });
}, 300000); // Run every 5 minutes

// Mark sessions as stale if no updates in 2 minutes
setInterval(() => {
  const now = Date.now();
  Object.values(sessions).forEach(session => {
    if (session.active && session.playing && now - session.lastUpdated > 120000) {
      console.log(`⏸️ Auto-pausing stale session for ${session.app}`);
      session.playing = false;
    }
  });
}, 60000); // Check every minute

// CREATE SESSION (per app) - ACCEPTS INITIAL SONG DATA WITH POSITION AND USER INFO
app.post("/session", (req, res) => {
  const id = Math.random().toString(36).slice(2, 10);

  // Extract all fields including position, user, and extended metadata
  const {
    app,
    song,
    artist,
    album,
    albumArt,
    duration,
    position,
    playing,
    user,
    // Extended metadata from Gemini AI
    genre,
    year,
    label,
    trackCount,
    albumDescription,
    artistBio
  } = req.body;

  // Validate required fields
  if (!app) {
    return res.status(400).json({
      error: "Missing required field: app"
    });
  }

  // Create session with complete initial data including user info and extended metadata
  sessions[id] = {
    app: app,
    albumArt: ensureHttps(albumArt) || "",
    currentSong: song || null,
    currentArtist: artist || null,
    album: album || null,
    active: true,
    playing: playing || false,
    songPosition: position || 0,
    songDuration: duration || 0,
    lastPlayStart: playing ? Date.now() : null,
    totalPlayTime: 0,
    createdAt: Date.now(),
    lastUpdated: Date.now(),
    // Store user info with the session
    user: user ? {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl
    } : null,
    // Extended metadata from Gemini AI
    genre: genre || null,
    year: year || null,
    label: label || null,
    trackCount: trackCount || null,
    albumDescription: albumDescription || null,
    artistBio: artistBio || null,
    artistImage: ensureHttps(artistImage) || null
  };

  console.log(`✅ Session created: ${id} for ${app}`);
  if (user) {
    console.log(`   👤 User: ${user.displayName} (@${user.username})`);
  }
  if (song) {
    console.log(`   🎵 Initial song: ${song} - ${artist}`);
    console.log(`   💿 Album: ${album || 'Unknown'}${year ? ` (${year})` : ''}`);
    if (genre) console.log(`   🎸 Genre: ${genre}`);
    if (label) console.log(`   🏷️ Label: ${label}`);
    console.log(`   ⏱️ Duration: ${duration}s, Position: ${position || 0}s`);
    console.log(`   ${playing ? '▶️ Playing' : '⏸️ Paused'}`);
    
    // Add to history when session starts with a song (include user and extended metadata)
    addToHistory({ song, artist, album, albumArt, app, duration, user, genre, year, label, artistImage });
  }

  res.json({ sessionId: id, url: `/s/${id}` });
});

// Helper function to update current song position
function updateSongPosition(session) {
  if (session.playing && session.lastPlayStart) {
    const elapsed = Math.floor((Date.now() - session.lastPlayStart) / 1000);
    session.songPosition += elapsed;
    session.totalPlayTime += elapsed;
    session.lastPlayStart = Date.now();
  }
}

// UPDATE SESSION (when song changes or play/pause or position update)
app.put("/session/:id", (req, res) => {
  const session = sessions[req.params.id];

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  if (!session.active) {
    return res.status(410).json({ error: "Session has ended" });
  }
  
  const { 
    song, artist, album, albumArt, playing, duration, position,
    // Extended metadata from Gemini AI
    genre, year, label, trackCount, albumDescription, artistBio, artistImage
  } = req.body;

  // Check if song changed
  const songChanged = song !== undefined && song !== session.currentSong;

  // If position is explicitly provided from client, use it as authoritative source
  if (position !== undefined) {
    session.songPosition = position;
    session.lastPlayStart = playing ? Date.now() : null;
  }
  // Otherwise update position based on elapsed time
  else if (!songChanged) {
    updateSongPosition(session);
  }

  // If song changed, reset position (unless explicitly provided)
  if (songChanged) {
    console.log(`🎵 Song changed in session ${req.params.id}:`);
    console.log(`   From: "${session.currentSong}"`);
    console.log(`   To: "${song}"`);

    if (position === undefined) {
      session.songPosition = 0;
    }
    session.lastPlayStart = playing ? Date.now() : null;
    
    // Add new song to history (include user from session and extended metadata)
    addToHistory({
      song,
      artist: artist || session.currentArtist,
      album: album || session.album,
      albumArt: albumArt || session.albumArt,
      app: session.app,
      duration: duration || session.songDuration,
      user: session.user,
      genre: genre || session.genre,
      year: year || session.year,
      label: label || session.label,
      artistImage: artistImage || session.artistImage
    });
  }

  // Update song info
  if (song !== undefined) session.currentSong = song;
  if (artist !== undefined) session.currentArtist = artist;
  if (album !== undefined) session.album = album;
  if (albumArt !== undefined) session.albumArt = albumArt;
  if (duration !== undefined) session.songDuration = duration;
  
  // Update extended metadata
  if (genre !== undefined) session.genre = genre;
  if (year !== undefined) session.year = year;
  if (label !== undefined) session.label = label;
  if (trackCount !== undefined) session.trackCount = trackCount;
  if (albumDescription !== undefined) session.albumDescription = albumDescription;
  if (artistBio !== undefined) session.artistBio = artistBio;
  if (artistImage !== undefined) session.artistImage = ensureHttps(artistImage) || null;

  // Update playing state
  if (playing !== undefined && !songChanged) {
    if (playing && !session.playing) {
      // Started playing
      session.lastPlayStart = Date.now();
      console.log(`▶️ Session ${req.params.id} resumed: ${song || session.currentSong} at ${session.songPosition}s`);
    } else if (!playing && session.playing) {
      // Paused
      updateSongPosition(session);
      session.lastPlayStart = null;
      console.log(`⏸️ Session ${req.params.id} paused at ${session.songPosition}s`);
    }
    session.playing = playing;
  }

  session.lastUpdated = Date.now();

  res.json({ success: true, sessionId: req.params.id });
});

// END SESSION (when app closes or switches)
app.delete("/session/:id", (req, res) => {
  const session = sessions[req.params.id];

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  // Update position one last time
  updateSongPosition(session);

  session.active = false;
  session.playing = false;
  session.lastPlayStart = null;

  console.log(`🛑 Session ${req.params.id} ended for ${session.app}`);
  console.log(`   Total play time: ${session.totalPlayTime}s`);
  console.log(`   Last song: ${session.currentSong || 'None'}`);

  res.json({ success: true, message: "Session ended" });
});

// GET SESSION - Returns real-time calculated position AND user info AND extended metadata
app.get("/session/:id", (req, res) => {
  const session = sessions[req.params.id];

  if (!session) {
    return res.status(404).json({ error: "INVALID SESSION" });
  }

  // Calculate current position in song in real-time
  let currentPosition = session.songPosition;
  if (session.playing && session.lastPlayStart) {
    const elapsedSinceLastUpdate = Math.floor((Date.now() - session.lastPlayStart) / 1000);
    currentPosition += elapsedSinceLastUpdate;
  }

  // Clamp position to duration to prevent overflow
  if (session.songDuration > 0) {
    currentPosition = Math.min(currentPosition, session.songDuration);
  }

  // Calculate total play time
  let totalDuration = session.totalPlayTime;
  if (session.playing && session.lastPlayStart) {
    totalDuration += Math.floor((Date.now() - session.lastPlayStart) / 1000);
  }

  // Don't send internal fields to frontend
  const { createdAt, lastUpdated, lastPlayStart, totalPlayTime, songPosition, ...sessionData } = session;

  res.json({
    ...sessionData,
    position: currentPosition,
    duration: session.songDuration,
    totalPlayTime: totalDuration,
    status: session.active ? (session.playing ? "playing" : "paused") : "stopped",
    genre: session.genre || null,
    year: session.year || null,
    label: session.label || null,
    trackCount: session.trackCount || null,
    albumDescription: session.albumDescription || null,
    artistBio: session.artistBio || null
  });
});

// GET ALL ACTIVE SESSIONS (useful for debugging)
app.get("/sessions/active", (req, res) => {
  const activeSessions = Object.entries(sessions)
    .filter(([_, session]) => session.active)
    .map(([id, session]) => {
      let currentPosition = session.songPosition;
      if (session.playing && session.lastPlayStart) {
        currentPosition += Math.floor((Date.now() - session.lastPlayStart) / 1000);
      }

      // Clamp position to duration
      if (session.songDuration > 0) {
        currentPosition = Math.min(currentPosition, session.songDuration);
      }

      let totalDuration = session.totalPlayTime;
      if (session.playing && session.lastPlayStart) {
        totalDuration += Math.floor((Date.now() - session.lastPlayStart) / 1000);
      }

      return {
        id,
        app: session.app,
        currentSong: session.currentSong,
        currentArtist: session.currentArtist,
        album: session.album,
        position: currentPosition,
        duration: session.songDuration,
        totalPlayTime: totalDuration,
        playing: session.playing,
        lastUpdated: new Date(session.lastUpdated).toISOString(),
        user: session.user
      };
    });

  res.json({
    count: activeSessions.length,
    sessions: activeSessions
  });
});

// GET sessions by user ID
app.get("/sessions/user/:userId", (req, res) => {
  const userId = req.params.userId;
  
  const userSessions = Object.entries(sessions)
    .filter(([_, session]) => session.active && session.user?.id === userId)
    .map(([id, session]) => {
      let currentPosition = session.songPosition;
      if (session.playing && session.lastPlayStart) {
        currentPosition += Math.floor((Date.now() - session.lastPlayStart) / 1000);
      }

      if (session.songDuration > 0) {
        currentPosition = Math.min(currentPosition, session.songDuration);
      }

      return {
        id,
        app: session.app,
        currentSong: session.currentSong,
        currentArtist: session.currentArtist,
        album: session.album,
        albumArt: session.albumArt,
        position: currentPosition,
        duration: session.songDuration,
        playing: session.playing,
        user: session.user
      };
    });

  res.json({
    count: userSessions.length,
    userId: userId,
    sessions: userSessions
  });
});

// HEALTH CHECK
app.get("/health", (req, res) => {
  const totalSessions = Object.keys(sessions).length;
  const activeSessions = Object.values(sessions).filter(s => s.active).length;
  const playingSessions = Object.values(sessions).filter(s => s.playing).length;

  res.json({
    status: "ok",
    uptime: process.uptime(),
    sessions: {
      total: totalSessions,
      active: activeSessions,
      playing: playingSessions,
      inactive: totalSessions - activeSessions
    },
    history: {
      total: history.length,
      maxSize: MAX_HISTORY_ITEMS
    }
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🎵 LIVIA backend running on port ${PORT}`);
  console.log("📝 Endpoints:");
  console.log("   POST   /session          - Create new session (with optional initial song data + position + user)");
  console.log("   PUT    /session/:id      - Update current song/state (add 'position' for sync)");
  console.log("   DELETE /session/:id      - End session");
  console.log("   GET    /session/:id      - Get session info (with real-time position + user)");
  console.log("   GET    /sessions/active  - List active sessions");
  console.log("   GET    /sessions/user/:id - Get sessions for a specific user");
  console.log("   GET    /health           - Health check");
  console.log("");
  console.log("📚 History Endpoints:");
  console.log("   GET    /history          - Get recently played tracks (?limit=N)");
  console.log("   GET    /history/session/:id - Get history for specific session's app");
  console.log("   GET    /history/user/:id - Get history for specific user");
  console.log("   DELETE /history          - Clear all history");
  console.log("   DELETE /history/:trackId - Remove specific track from history");
  console.log("");
  console.log(`✨ History loaded: ${history.length} tracks`);
  console.log("🔧 Features:");
  console.log("   ✅ Real-time position calculation in GET endpoint");
  console.log("   ✅ Position parameter support in POST/PUT");
  console.log("   ✅ User info stored per session (Discord user data)");
  console.log("   ✅ Improved session cleanup (inactive + stale checks)");
  console.log("   ✅ Auto-pause stale sessions after 2 minutes");
  console.log("   ✅ Persistent track history (saved to disk)");
  console.log("   ✅ History survives server restarts");
});
