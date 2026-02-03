/**
 * Livia Chrome Extension - Popup Script
 */

const API_BASE = 'https://livia.mom';

// Elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const nowPlaying = document.getElementById('nowPlaying');
const albumArt = document.getElementById('albumArt');
const trackTitle = document.getElementById('trackTitle');
const trackArtist = document.getElementById('trackArtist');
const trackApp = document.getElementById('trackApp');
const sessionLink = document.getElementById('sessionLink');
const sessionUrl = document.getElementById('sessionUrl');
const instructions = document.getElementById('instructions');

// Get status from background script
async function updateStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    
    if (response.sessionId && response.lastTrack) {
      // Active session
      statusIndicator.classList.add('active');
      statusText.textContent = response.lastTrack.playing ? 'Now Playing' : 'Paused';
      
      // Show track info
      nowPlaying.classList.add('visible');
      trackTitle.textContent = response.lastTrack.title || '-';
      trackArtist.textContent = response.lastTrack.artist || '-';
      trackApp.textContent = response.lastTrack.app || 'Unknown';
      
      if (response.lastTrack.albumArt) {
        albumArt.src = response.lastTrack.albumArt;
        albumArt.style.display = 'block';
      } else {
        albumArt.style.display = 'none';
      }
      
      // Show session link
      sessionLink.classList.add('visible');
      sessionUrl.href = `${API_BASE}/s/${response.sessionId}`;
      
      // Hide instructions
      instructions.style.display = 'none';
    } else {
      // No active session
      statusIndicator.classList.remove('active');
      statusText.textContent = 'Waiting for music...';
      nowPlaying.classList.remove('visible');
      sessionLink.classList.remove('visible');
      instructions.style.display = 'block';
    }
  } catch (error) {
    console.error('Error getting status:', error);
    statusText.textContent = 'Extension error';
  }
}

// Initialize
updateStatus();

// Refresh every 2 seconds while popup is open
setInterval(updateStatus, 2000);
