/**
 * Livia Chrome Extension - Background Service Worker
 * Manages session lifecycle and communication between content scripts and API
 */

const API_BASE = 'https://api.livia.mom';

// State
let currentSession = null;
let lastTrackData = null;

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('Livia extension installed');
  chrome.storage.local.set({ enabled: true, sessionId: null });
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received:', message.type);
  
  switch (message.type) {
    case 'TRACK_UPDATE':
      handleTrackUpdate(message.data, sender.tab);
      sendResponse({ success: true });
      break;
      
    case 'PLAYBACK_STATE':
      handlePlaybackState(message.data);
      sendResponse({ success: true });
      break;
      
    case 'GET_STATUS':
      sendResponse({ 
        enabled: true,
        sessionId: currentSession,
        lastTrack: lastTrackData 
      });
      break;
      
    case 'STOP_SESSION':
      endSession();
      sendResponse({ success: true });
      break;
  }
  
  return true; // Keep channel open for async response
});

// Handle track updates from content scripts
async function handleTrackUpdate(trackData, tab) {
  const { title, artist, album, albumArt, duration, position, playing, app } = trackData;
  
  // Skip if nothing changed
  if (lastTrackData && 
      lastTrackData.title === title && 
      lastTrackData.artist === artist &&
      lastTrackData.playing === playing) {
    return;
  }
  
  lastTrackData = trackData;
  
  // Check if song changed or this is a new session
  const songChanged = !currentSession || 
    (lastTrackData && (lastTrackData.title !== title || lastTrackData.artist !== artist));
  
  try {
    if (!currentSession) {
      // Create new session
      const response = await fetch(`${API_BASE}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app: app || 'Spotify Web',
          song: title,
          artist: artist,
          album: album,
          albumArt: albumArt,
          duration: duration,
          position: position,
          playing: playing
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        currentSession = data.sessionId;
        chrome.storage.local.set({ sessionId: currentSession });
        console.log('Session created:', currentSession);
        
        // Update badge to show active
        chrome.action.setBadgeText({ text: '♪' });
        chrome.action.setBadgeBackgroundColor({ color: '#1DB954' });
      }
    } else {
      // Update existing session
      await fetch(`${API_BASE}/session/${currentSession}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          song: title,
          artist: artist,
          album: album,
          albumArt: albumArt,
          duration: duration,
          position: position,
          playing: playing
        })
      });
      console.log('Session updated:', title, '-', artist);
    }
  } catch (error) {
    console.error('API error:', error);
  }
}

// Handle playback state changes (play/pause)
async function handlePlaybackState(data) {
  if (!currentSession) return;
  
  try {
    await fetch(`${API_BASE}/session/${currentSession}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playing: data.playing,
        position: data.position
      })
    });
    
    // Update badge
    if (data.playing) {
      chrome.action.setBadgeText({ text: '♪' });
      chrome.action.setBadgeBackgroundColor({ color: '#1DB954' });
    } else {
      chrome.action.setBadgeText({ text: '⏸' });
      chrome.action.setBadgeBackgroundColor({ color: '#666' });
    }
  } catch (error) {
    console.error('Playback state update error:', error);
  }
}

// End the current session
async function endSession() {
  if (!currentSession) return;
  
  try {
    await fetch(`${API_BASE}/session/${currentSession}`, {
      method: 'DELETE'
    });
    console.log('Session ended:', currentSession);
  } catch (error) {
    console.error('Session end error:', error);
  }
  
  currentSession = null;
  lastTrackData = null;
  chrome.storage.local.set({ sessionId: null });
  chrome.action.setBadgeText({ text: '' });
}

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  // Could track which tab has the music player and end session
});
