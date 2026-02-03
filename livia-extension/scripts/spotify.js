/**
 * Livia Chrome Extension - Spotify Web Player Content Script
 * Detects currently playing music from open.spotify.com
 */

console.log('Livia: Spotify content script loaded');

// State
let lastTrackInfo = null;
let observer = null;
let updateInterval = null;

// Selectors for Spotify Web Player (these may need updates if Spotify changes their UI)
const SELECTORS = {
  // Now Playing Bar (bottom of screen)
  trackName: '[data-testid="context-item-link"]',
  artistName: '[data-testid="context-item-info-artist"]',
  albumArt: '[data-testid="CoverSlotCollapsed__Container"] img',
  playButton: '[data-testid="control-button-playpause"]',
  progressBar: '[data-testid="playback-progressbar"]',
  currentTime: '[data-testid="playback-position"]',
  duration: '[data-testid="playback-duration"]',
  
  // Alternative selectors (Spotify updates their UI sometimes)
  trackNameAlt: '.Root__now-playing-bar [dir="auto"] a',
  artistNameAlt: '.Root__now-playing-bar span a[href^="/artist"]',
  albumArtAlt: '.Root__now-playing-bar img[src*="i.scdn.co"]'
};

// Parse time string (e.g., "3:45") to seconds
function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

// Get current track info from the DOM
function getTrackInfo() {
  try {
    // Try primary selectors first
    let trackEl = document.querySelector(SELECTORS.trackName);
    let artistEl = document.querySelector(SELECTORS.artistName);
    let albumArtEl = document.querySelector(SELECTORS.albumArt);
    
    // Fallback to alternative selectors
    if (!trackEl) trackEl = document.querySelector(SELECTORS.trackNameAlt);
    if (!artistEl) artistEl = document.querySelector(SELECTORS.artistNameAlt);
    if (!albumArtEl) albumArtEl = document.querySelector(SELECTORS.albumArtAlt);
    
    if (!trackEl || !artistEl) {
      return null;
    }
    
    // Get track and artist names
    const title = trackEl.textContent?.trim();
    const artist = artistEl.textContent?.trim();
    
    if (!title || !artist) {
      return null;
    }
    
    // Get album art (high resolution)
    let albumArt = null;
    if (albumArtEl) {
      albumArt = albumArtEl.src;
      // Convert to higher resolution (Spotify uses ab67616d for album art)
      if (albumArt && albumArt.includes('i.scdn.co')) {
        // Replace size indicator to get larger image
        albumArt = albumArt.replace(/\/\d+x\d+\//, '/640x640/');
      }
    }
    
    // Get play/pause state
    const playButton = document.querySelector(SELECTORS.playButton);
    const isPlaying = playButton?.getAttribute('aria-label')?.toLowerCase().includes('pause') || 
                      playButton?.querySelector('svg')?.innerHTML?.includes('pause');
    
    // Get progress
    const currentTimeEl = document.querySelector(SELECTORS.currentTime);
    const durationEl = document.querySelector(SELECTORS.duration);
    const position = parseTime(currentTimeEl?.textContent);
    const duration = parseTime(durationEl?.textContent);
    
    // Try to get album name from the track link
    let album = null;
    const trackLink = trackEl.getAttribute?.('href');
    if (trackLink && trackLink.includes('/album/')) {
      // Could fetch album name, but for now just use the page title
      const pageTitle = document.title;
      if (pageTitle && pageTitle.includes(' - ')) {
        // Spotify title format: "Song - Artist | Spotify"
        // Album might be in different element
      }
    }
    
    return {
      title,
      artist,
      album: album || '',
      albumArt,
      duration,
      position,
      playing: isPlaying,
      app: 'Spotify Web'
    };
  } catch (error) {
    console.error('Livia: Error getting track info:', error);
    return null;
  }
}

// Send track update to background script
function sendTrackUpdate(trackInfo) {
  if (!trackInfo) return;
  
  // Check if anything meaningful changed
  if (lastTrackInfo && 
      lastTrackInfo.title === trackInfo.title &&
      lastTrackInfo.artist === trackInfo.artist &&
      lastTrackInfo.playing === trackInfo.playing) {
    // Only position changed, update less frequently
    return;
  }
  
  console.log('Livia: Track update:', trackInfo.title, '-', trackInfo.artist);
  lastTrackInfo = trackInfo;
  
  chrome.runtime.sendMessage({
    type: 'TRACK_UPDATE',
    data: trackInfo
  }).catch(err => {
    // Extension context may be invalidated
    console.log('Livia: Could not send message', err);
  });
}

// Send playback state update
function sendPlaybackState(playing, position) {
  chrome.runtime.sendMessage({
    type: 'PLAYBACK_STATE',
    data: { playing, position }
  }).catch(() => {});
}

// Check for updates
function checkForUpdates() {
  const trackInfo = getTrackInfo();
  if (trackInfo) {
    sendTrackUpdate(trackInfo);
  }
}

// Set up mutation observer to detect changes
function setupObserver() {
  // Find the now playing bar
  const nowPlayingBar = document.querySelector('.Root__now-playing-bar') || 
                        document.querySelector('[data-testid="now-playing-bar"]') ||
                        document.querySelector('footer');
  
  if (!nowPlayingBar) {
    // Retry after a delay if not found
    setTimeout(setupObserver, 2000);
    return;
  }
  
  console.log('Livia: Setting up observer on now playing bar');
  
  observer = new MutationObserver((mutations) => {
    // Debounce updates
    clearTimeout(window.liviaUpdateTimeout);
    window.liviaUpdateTimeout = setTimeout(checkForUpdates, 300);
  });
  
  observer.observe(nowPlayingBar, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true
  });
  
  // Also check periodically for position updates
  updateInterval = setInterval(() => {
    const trackInfo = getTrackInfo();
    if (trackInfo && lastTrackInfo) {
      // Only send position updates if playing
      if (trackInfo.playing) {
        sendPlaybackState(trackInfo.playing, trackInfo.position);
      }
    }
  }, 5000); // Every 5 seconds
  
  // Initial check
  checkForUpdates();
}

// Wait for page to be ready
function init() {
  // Wait for Spotify's player to load
  const checkReady = setInterval(() => {
    const hasPlayer = document.querySelector('.Root__now-playing-bar') || 
                      document.querySelector('[data-testid="now-playing-bar"]') ||
                      document.querySelector(SELECTORS.trackName);
    
    if (hasPlayer) {
      clearInterval(checkReady);
      console.log('Livia: Spotify player detected, initializing...');
      setupObserver();
    }
  }, 1000);
  
  // Stop checking after 30 seconds
  setTimeout(() => clearInterval(checkReady), 30000);
}

// Clean up on unload
window.addEventListener('beforeunload', () => {
  if (observer) observer.disconnect();
  if (updateInterval) clearInterval(updateInterval);
  
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }).catch(() => {});
});

// Start
init();
