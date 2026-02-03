/**
 * Livia Chrome Extension - Apple Music Web Content Script
 * Detects currently playing music from music.apple.com
 */

console.log('Livia: Apple Music content script loaded');

// State
let lastTrackInfo = null;
let observer = null;
let updateInterval = null;

// Selectors for Apple Music Web Player
const SELECTORS = {
  // Now Playing section
  trackName: '[data-testid="song-name"]',
  artistName: '[data-testid="song-subtitle"]',
  albumArt: '.lcd-player-header img.media-artwork-v2__image',
  
  // Alternative selectors
  trackNameAlt: '.lcd-player__song-name',
  artistNameAlt: '.lcd-player__song-name-container .lcd-player__song-subtitle',
  albumArtAlt: '.lcd-player-header .media-artwork-v2 img',
  
  // Player controls
  playButton: '.lcd-player-button--play',
  pauseButton: '.lcd-player-button--pause',
  playPauseButton: '[data-testid="play-pause-button"]',
  
  // Progress
  progressBar: '.lcd-player__progress-bar',
  currentTime: '.lcd-player__time--current',
  duration: '.lcd-player__time--remaining',
  
  // Web player specific (music.apple.com)
  webTrackName: '[class*="songs-list-row__song-name"]',
  webArtistName: '[class*="songs-list-row__artist-name"]',
  webNowPlaying: '[class*="lcd-playing"]',
  
  // Mini player
  miniTrackName: '.web-chrome__lcd-player-name',
  miniArtistName: '.web-chrome__lcd-player-artist'
};

// Parse time string (e.g., "3:45" or "-1:30") to seconds
function parseTime(timeStr) {
  if (!timeStr) return 0;
  const isNegative = timeStr.startsWith('-');
  const cleanStr = timeStr.replace('-', '');
  const parts = cleanStr.split(':').map(Number);
  let seconds = 0;
  if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return isNegative ? -seconds : seconds;
}

// Get current track info from the DOM
function getTrackInfo() {
  try {
    // Try multiple selector strategies
    let title = null;
    let artist = null;
    let albumArt = null;
    
    // Strategy 1: LCD Player (full player view)
    let trackEl = document.querySelector(SELECTORS.trackName) || 
                  document.querySelector(SELECTORS.trackNameAlt);
    let artistEl = document.querySelector(SELECTORS.artistName) || 
                   document.querySelector(SELECTORS.artistNameAlt);
    let albumArtEl = document.querySelector(SELECTORS.albumArt) || 
                     document.querySelector(SELECTORS.albumArtAlt);
    
    // Strategy 2: Mini player in web chrome
    if (!trackEl) {
      trackEl = document.querySelector(SELECTORS.miniTrackName);
      artistEl = document.querySelector(SELECTORS.miniArtistName);
    }
    
    // Strategy 3: Look for the now playing indicator in a list
    if (!trackEl) {
      const nowPlayingRow = document.querySelector('[class*="songs-list-row--playing"]');
      if (nowPlayingRow) {
        trackEl = nowPlayingRow.querySelector('[class*="song-name"]');
        artistEl = nowPlayingRow.querySelector('[class*="artist-name"]');
      }
    }
    
    if (!trackEl) {
      // Strategy 4: Check document title (Apple Music sets it to "Song - Artist")
      const docTitle = document.title;
      if (docTitle && docTitle.includes(' - ') && !docTitle.includes('Apple Music')) {
        const parts = docTitle.split(' - ');
        if (parts.length >= 2) {
          title = parts[0].trim();
          artist = parts.slice(1).join(' - ').replace(' - Apple Music', '').trim();
        }
      }
    } else {
      title = trackEl.textContent?.trim();
      artist = artistEl?.textContent?.trim();
    }
    
    if (!title || !artist) {
      return null;
    }
    
    // Get album art
    if (albumArtEl) {
      albumArt = albumArtEl.src;
      // Apple Music uses different size URLs, get larger version
      if (albumArt) {
        // Replace dimensions to get higher resolution
        albumArt = albumArt.replace(/\/\d+x\d+[a-z]*\./, '/600x600bb.');
      }
    }
    
    // If no album art from player, try to find it elsewhere
    if (!albumArt) {
      const anyAlbumArt = document.querySelector('.media-artwork-v2 img') ||
                          document.querySelector('[class*="album-artwork"] img');
      if (anyAlbumArt) {
        albumArt = anyAlbumArt.src?.replace(/\/\d+x\d+[a-z]*\./, '/600x600bb.');
      }
    }
    
    // Get play/pause state
    let isPlaying = false;
    const playButton = document.querySelector(SELECTORS.playButton);
    const pauseButton = document.querySelector(SELECTORS.pauseButton);
    const playPauseButton = document.querySelector(SELECTORS.playPauseButton);
    
    if (pauseButton && pauseButton.offsetParent !== null) {
      isPlaying = true;
    } else if (playPauseButton) {
      const ariaLabel = playPauseButton.getAttribute('aria-label')?.toLowerCase();
      isPlaying = ariaLabel?.includes('pause');
    }
    
    // Also check for audio element
    const audioEl = document.querySelector('audio');
    if (audioEl && !audioEl.paused) {
      isPlaying = true;
    }
    
    // Get progress
    const currentTimeEl = document.querySelector(SELECTORS.currentTime);
    const durationEl = document.querySelector(SELECTORS.duration);
    let position = parseTime(currentTimeEl?.textContent);
    let duration = Math.abs(parseTime(durationEl?.textContent));
    
    // If duration shows remaining time, calculate total
    if (durationEl?.textContent?.startsWith('-') && position > 0) {
      duration = position + duration;
    }
    
    // Try to get album name
    let album = null;
    const albumLink = document.querySelector('[class*="song-name-container"] a[href*="/album/"]');
    if (albumLink) {
      album = albumLink.textContent?.trim();
    }
    
    return {
      title,
      artist,
      album: album || '',
      albumArt,
      duration,
      position,
      playing: isPlaying,
      app: 'Apple Music Web'
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
    return;
  }
  
  console.log('Livia: Track update:', trackInfo.title, '-', trackInfo.artist);
  lastTrackInfo = trackInfo;
  
  chrome.runtime.sendMessage({
    type: 'TRACK_UPDATE',
    data: trackInfo
  }).catch(err => {
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
  // Find the player area - Apple Music structure varies
  const playerArea = document.querySelector('.web-chrome__lcd') ||
                     document.querySelector('[class*="lcd-player"]') ||
                     document.querySelector('#apple-music-player') ||
                     document.body;
  
  console.log('Livia: Setting up observer on', playerArea.className || 'body');
  
  observer = new MutationObserver((mutations) => {
    // Debounce updates
    clearTimeout(window.liviaUpdateTimeout);
    window.liviaUpdateTimeout = setTimeout(checkForUpdates, 300);
  });
  
  observer.observe(playerArea, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'aria-label', 'src']
  });
  
  // Also check periodically for position updates
  updateInterval = setInterval(() => {
    const trackInfo = getTrackInfo();
    if (trackInfo && lastTrackInfo) {
      if (trackInfo.playing) {
        sendPlaybackState(trackInfo.playing, trackInfo.position);
      }
    }
  }, 5000);
  
  // Initial check
  setTimeout(checkForUpdates, 1000);
}

// Initialize
function init() {
  console.log('Livia: Initializing Apple Music detection...');
  
  // Wait a bit for Apple Music's player to initialize
  setTimeout(() => {
    setupObserver();
    checkForUpdates();
  }, 2000);
}

// Clean up on unload
window.addEventListener('beforeunload', () => {
  if (observer) observer.disconnect();
  if (updateInterval) clearInterval(updateInterval);
  
  chrome.runtime.sendMessage({ type: 'STOP_SESSION' }).catch(() => {});
});

// Start
init();
