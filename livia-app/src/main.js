const { app, Tray, Menu, nativeImage, Notification, shell, dialog, BrowserWindow } = require('electron');
const path = require('path');
const Store = require('electron-store');
const DiscordRPC = require('discord-rpc');
const fetch = require('node-fetch');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Modules
const MediaDetector = require('./media-detector');
const AlbumArtFetcher = require('./album-art');

// ============ Configuration ============
const store = new Store({
  defaults: {
    discordAppId: process.env.DISCORD_APP_ID || '',
    apiBaseUrl: process.env.API_BASE_URL || 'https://api.livia.mom',
    startWithSystem: false,
    showNotifications: true,
    lastFmApiKey: process.env.LASTFM_API_KEY || '',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    firstRun: true
  }
});

// ============ App State ============
let tray = null;
let hiddenWindow = null; // Hidden window for dialogs
let discordClient = null;
let mediaDetector = null;
let albumArtFetcher = null;
let retryCount = 0;
const MAX_RETRIES = 5;

// Discord user info
let discordUser = {
  id: null,
  username: null,
  displayName: null,
  avatarUrl: null
};

// Session tracking
let currentSessionId = null;
let currentSessionUrl = 'https://livia.mom/';
let lastSongId = '';
let lastAlbumArtUrl = null;
let lastAlbumName = null;
let lastCleanedSong = null;
let lastCleanedArtist = null;
let isRunning = true;
let lastPlayingState = false;

// Extended metadata from Gemini AI
let lastGenre = null;
let lastYear = null;
let lastLabel = null;
let lastTrackCount = null;
let lastAlbumDescription = null;
let lastArtistBio = null;
let lastArtistImage = null;

// ============ Prevent Multiple Instances ============
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // User tried to run a second instance - show notification
    if (tray) {
      showNotification('Livia is already running', 'Check your system tray!');
    }
  });
}

// ============ App Lifecycle ============
app.whenReady().then(async () => {
  // Hide dock icon on macOS (tray-only app)
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  // Create hidden window for dialogs (required on Windows)
  hiddenWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false
    }
  });

  // Initialize tray first so user sees the app
  initializeTray();
  updateTrayStatus('Connecting to Discord...');

  // Show first-run message AFTER tray is created
  if (store.get('firstRun')) {
    store.set('firstRun', false);
    // Small delay to ensure tray is visible first
    setTimeout(() => showWelcomeMessage(), 500);
  }

  // Initialize components
  mediaDetector = new MediaDetector();
  albumArtFetcher = new AlbumArtFetcher(store.get('lastFmApiKey'), store.get('geminiApiKey'));

  // Connect to Discord (with retry logic)
  await initializeDiscord();

  // Setup auto-launch
  setupAutoLaunch();

  // Start the main loop
  startMainLoop();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', async () => {
  isRunning = false;
  
  // End session gracefully
  if (currentSessionId) {
    try {
      await endSession();
    } catch {}
  }
  
  cleanup();
});

// ============ Welcome Message ============
function showWelcomeMessage() {
  dialog.showMessageBox(hiddenWindow, {
    type: 'info',
    title: 'Welcome to Livia!',
    message: 'Livia is now running in your system tray',
    detail: 'Livia will automatically detect your music and show it on Discord.\n\n' +
            '• Look for the Livia icon in your system tray (bottom-right)\n' +
            '• Right-click the tray icon for options\n' +
            '• Make sure Discord is running!\n\n' +
            'Supported apps: Spotify, Apple Music, YouTube Music, and more!',
    buttons: ['Got it!'],
    defaultId: 0,
    noLink: true
  }).catch(err => console.error('Dialog error:', err));
}

// ============ Discord RPC ============
async function initializeDiscord() {
  const clientId = store.get('discordAppId');
  
  DiscordRPC.register(clientId);
  discordClient = new DiscordRPC.Client({ transport: 'ipc' });
  
  discordClient.on('ready', () => {
    retryCount = 0; // Reset retry count on successful connection
    
    const user = discordClient.user;
    
    discordUser = {
      id: user.id,
      username: user.username,
      displayName: user.global_name || user.username,
      avatarUrl: user.avatar 
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`
    };

    console.log(`✅ Connected as: ${discordUser.displayName}`);
    
    updateTrayTooltip(`Livia - ${discordUser.displayName}`);
    updateTrayStatus('Ready - Waiting for music...');
    showNotification('Connected to Discord', `Signed in as ${discordUser.displayName}`);
  });

  discordClient.on('disconnected', () => {
    console.log('❌ Discord disconnected');
    updateTrayStatus('Disconnected from Discord');
    updateTrayTooltip('Livia - Disconnected');
    
    // Try to reconnect
    scheduleReconnect();
  });

  try {
    await discordClient.login({ clientId });
  } catch (error) {
    console.error('Failed to connect to Discord:', error.message);
    updateTrayStatus('Cannot connect to Discord');
    showNotification('Connection Failed', 'Make sure Discord is running!');
    
    // Schedule retry
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!isRunning) return;
  
  retryCount++;
  if (retryCount > MAX_RETRIES) {
    console.log('Max retries reached, waiting for user action');
    updateTrayStatus('Discord not found - Click to retry');
    return;
  }
  
  const delay = Math.min(5000 * retryCount, 30000); // Max 30 second delay
  console.log(`Reconnecting in ${delay/1000}s (attempt ${retryCount}/${MAX_RETRIES})`);
  updateTrayStatus(`Reconnecting in ${delay/1000}s...`);
  
  setTimeout(async () => {
    if (isRunning && (!discordClient || !discordClient.user)) {
      try {
        if (discordClient) {
          try {
            discordClient.destroy();
          } catch (destroyError) {
            // Ignore destroy errors - client may not be connected
          }
          discordClient = null;
        }
        await initializeDiscord();
      } catch (error) {
        scheduleReconnect();
      }
    }
  }, delay);
}

// ============ System Tray ============
function initializeTray() {
  const icon = createTrayIcon();
  
  tray = new Tray(icon);
  tray.setToolTip('Livia - Starting...');
  
  updateTrayMenu();
  
  tray.on('double-click', () => {
    if (currentSessionId) {
      shell.openExternal(currentSessionUrl);
    } else {
      shell.openExternal('https://livia.mom');
    }
  });
  
  // On Windows, show menu on left click too
  if (process.platform === 'win32') {
    tray.on('click', () => {
      tray.popUpContextMenu();
    });
  }
}

function createTrayIcon() {
  const fs = require('fs');
  
  // Different icon names per platform
  const iconName = process.platform === 'darwin' ? 'iconTemplate.png' : 
                   process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  
  // Try multiple possible locations
  const possiblePaths = [
    path.join(__dirname, '..', 'assets', iconName),
    path.join(__dirname, 'assets', iconName),
    path.join(process.resourcesPath || '', 'assets', iconName),
    path.join(app.getAppPath(), 'assets', iconName)
  ];
  
  for (const iconPath of possiblePaths) {
    try {
      if (fs.existsSync(iconPath)) {
        const icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
          return process.platform === 'darwin' ? icon : icon.resize({ width: 16, height: 16 });
        }
      }
    } catch {}
  }
  
  // Fallback: create a simple colored icon
  return createFallbackIcon();
}

function createFallbackIcon() {
  // Create a simple 16x16 purple square as fallback
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  
  for (let i = 0; i < size * size; i++) {
    canvas[i * 4] = 147;     // R (purple)
    canvas[i * 4 + 1] = 112; // G
    canvas[i * 4 + 2] = 219; // B
    canvas[i * 4 + 3] = 255; // A
  }
  
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

let currentStatus = 'Starting...';
let isStopped = false; // Track if Livia is stopped (but tray still visible)

function updateTrayStatus(status) {
  currentStatus = status;
  updateTrayMenu();
}

function updateTrayMenu() {
  let template;
  
  if (isStopped) {
    // Minimal menu when Livia is stopped
    template = [
      {
        label: 'Livia is stopped',
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Start Livia',
        click: async () => {
          isStopped = false;
          isRunning = true;
          updateTrayStatus('Connecting to Discord...');
          await initializeDiscord();
          startMainLoop();
        }
      },
      { type: 'separator' },
      {
        label: 'Uninstall Livia',
        click: async () => {
          const result = await dialog.showMessageBox(hiddenWindow, {
            type: 'warning',
            title: 'Uninstall Livia',
            message: 'Are you sure you want to uninstall Livia?',
            detail: 'This will remove Livia completely from your computer, including all settings and data.',
            buttons: ['Cancel', 'Uninstall'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          });
          
          if (result.response === 1) {
            await performUninstall();
          }
        }
      }
    ];
  } else {
    // Full menu when Livia is running
    template = [
      {
        label: currentStatus,
        enabled: false,
        icon: getStatusIcon()
      },
      { type: 'separator' },
      {
        label: discordUser.displayName ? `Signed in as ${discordUser.displayName}` : 'Not signed in',
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Start with System',
        type: 'checkbox',
        checked: store.get('startWithSystem'),
        click: (menuItem) => {
          store.set('startWithSystem', menuItem.checked);
          setupAutoLaunch();
          showNotification(
            menuItem.checked ? 'Auto-start enabled' : 'Auto-start disabled',
            menuItem.checked ? 'Livia will start when you log in' : 'Livia will not start automatically'
          );
        }
      },
      {
        label: 'Show Notifications',
        type: 'checkbox',
        checked: store.get('showNotifications'),
        click: (menuItem) => {
          store.set('showNotifications', menuItem.checked);
        }
      },
      { type: 'separator' },
      {
        label: 'Open Livia Website',
        click: () => shell.openExternal('https://livia.mom')
      },
      {
        label: 'View My Session',
        click: () => shell.openExternal(currentSessionUrl),
        visible: currentSessionId !== null
      },
      { type: 'separator' },
      {
        label: 'Reconnect to Discord',
        click: async () => {
          retryCount = 0;
          if (discordClient) {
            try {
              discordClient.destroy();
            } catch {}
            discordClient = null;
          }
          await initializeDiscord();
        },
        visible: !discordClient || !discordClient.user
      },
      { type: 'separator' },
      {
        label: 'Uninstall Livia',
        click: async () => {
          const result = await dialog.showMessageBox(hiddenWindow, {
            type: 'warning',
            title: 'Uninstall Livia',
            message: 'Are you sure you want to uninstall Livia?',
            detail: 'This will remove Livia completely from your computer, including all settings and data.',
            buttons: ['Cancel', 'Uninstall'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          });
          
          if (result.response === 1) {
            await performUninstall();
          }
        }
      },
      {
        label: 'Stop Livia',
        click: async () => {
          // Stop all functionality but keep tray
          isStopped = true;
          isRunning = false;
          
          // End session if active
          if (currentSessionId) {
            try {
              await endSession();
            } catch {}
            currentSessionId = null;
          }
          
          // Clear Discord presence
          clearDiscordPresence();
          
          // Disconnect from Discord
          if (discordClient) {
            try {
              discordClient.destroy();
            } catch {}
            discordClient = null;
          }
          
          // Reset state
          discordUser = { id: null, username: null, displayName: null, avatarUrl: null };
          lastSongId = '';
          lastPlayingState = false;
          currentSessionUrl = 'https://livia.mom/';
          
          updateTrayTooltip('Livia - Stopped');
          updateTrayMenu();
          showNotification('Livia Stopped', 'Click the tray icon to start again');
        }
      }
    ];
  }
  
  // Filter out invisible items
  const filteredTemplate = template.filter(item => item.visible !== false);
  
  const contextMenu = Menu.buildFromTemplate(filteredTemplate);
  tray.setContextMenu(contextMenu);
}

function getStatusIcon() {
  // Return null for now - could add status indicator icons later
  return null;
}

function updateTrayTooltip(text) {
  if (tray) {
    tray.setToolTip(text);
  }
}

// ============ Auto Launch ============
async function setupAutoLaunch() {
  const AutoLaunch = require('./auto-launch');
  const autoLauncher = new AutoLaunch();
  
  try {
    if (store.get('startWithSystem')) {
      await autoLauncher.enable();
    } else {
      await autoLauncher.disable();
    }
  } catch (error) {
    console.error('Auto-launch setup failed:', error.message);
  }
}

// ============ Main Loop ============
async function startMainLoop() {
  console.log('🔄 Starting main loop...');
  
  while (isRunning) {
    try {
      const media = await mediaDetector.getCurrentMedia();
      
      // Debug logging
      if (media) {
        console.log(`📡 Detected: ${media.title} - ${media.artist} [${media.state}] from ${media.app}`);
      }
      
      if (media && media.title && !isPlaceholder(media.title)) {
        const songId = `${media.title}|${media.artist}`;
        const isPlaying = media.state === 'playing';
        
        // Song changed
        if (songId !== lastSongId) {
          console.log(`🎵 Now Playing: ${media.title} - ${media.artist}`);
          lastSongId = songId;
          
          // Fetch album art (also cleans metadata via Gemini AI)
          // Pass thumbnail from SMTC if available
          const albumInfo = await albumArtFetcher.getAlbumInfo(
            media.title, 
            media.artist, 
            media.album,
            media.thumbnail  // Base64 thumbnail from Windows SMTC
          );
          lastAlbumArtUrl = albumInfo.artUrl;
          lastAlbumName = albumInfo.albumName || media.album;
          
          // Store cleaned metadata from AI parsing
          lastCleanedSong = albumInfo.cleanedSong || media.title;
          lastCleanedArtist = albumInfo.cleanedArtist || media.artist;
          
          // Store extended metadata from Gemini AI
          lastGenre = albumInfo.genre || null;
          lastYear = albumInfo.year || null;
          lastLabel = albumInfo.label || null;
          lastTrackCount = albumInfo.trackCount || null;
          lastAlbumDescription = albumInfo.albumDescription || null;
          lastArtistBio = albumInfo.artistBio || null;
          lastArtistImage = albumInfo.artistImage || null;
          
          console.log(`✨ Cleaned metadata: "${lastCleanedSong}" by "${lastCleanedArtist}"`);
          if (lastGenre || lastYear) {
            console.log(`📀 Album: "${lastAlbumName}" (${lastYear || 'Unknown year'}) - ${lastGenre || 'Unknown genre'}`);
          }
          
          // Create or update session with CLEANED data
          if (!currentSessionId) {
            currentSessionId = await createSession(media, isPlaying);
            if (currentSessionId) {
              currentSessionUrl = `https://livia.mom/s/${currentSessionId}`;
              console.log(`✅ Session: ${currentSessionUrl}`);
            }
          } else {
            await updateSession(media, isPlaying);
          }
          
          // Update Discord presence with cleaned data
          if (isPlaying) {
            setDiscordPresence(media);
          }
          
          // Update tray and show notification with cleaned data
          updateTrayStatus(`Playing: ${lastCleanedSong}`);
          updateTrayMenu();
          showNotification('Now Playing', `${lastCleanedSong} - ${lastCleanedArtist}`);
        }
        
        // Play/pause state changed
        if (isPlaying !== lastPlayingState) {
          console.log(isPlaying ? '▶️ Playing' : '⏸️ Paused');
          lastPlayingState = isPlaying;
          
          if (currentSessionId) {
            await updateSession(media, isPlaying);
          }
          
          if (isPlaying) {
            setDiscordPresence(media);
            updateTrayStatus(`Playing: ${media.title}`);
          } else {
            clearDiscordPresence();
            updateTrayStatus(`Paused: ${media.title}`);
          }
          updateTrayMenu();
        }
        
        // Heartbeat update (only when playing)
        if (currentSessionId && isPlaying && songId === lastSongId) {
          await updateSession(media, isPlaying);
        }
        
      } else {
        // No media playing
        if (currentSessionId || lastSongId) {
          console.log('⏹️ Stopped');
          if (currentSessionId) {
            await endSession();
            currentSessionId = null;
          }
          currentSessionUrl = 'https://livia.mom/';
          lastSongId = '';
          lastPlayingState = false;
          clearDiscordPresence();
          updateTrayStatus('Ready - Waiting for music...');
          updateTrayMenu();
        }
      }
      
    } catch (error) {
      console.error('Loop error:', error.message);
    }
    
    // Adaptive polling: faster when playing, slower when idle
    await sleep(lastPlayingState ? 3000 : 10000);
  }
}

// ============ Session Management ============
async function createSession(media, isPlaying) {
  try {
    const response = await fetch(`${store.get('apiBaseUrl')}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: media.app || 'Music',
        song: lastCleanedSong || media.title,
        artist: lastCleanedArtist || media.artist,
        album: lastAlbumName || media.album || '',
        albumArt: lastAlbumArtUrl || '',
        duration: media.duration || 0,
        position: media.position || 0,
        playing: isPlaying,
        user: discordUser.id ? discordUser : null,
        // Extended metadata from Gemini AI
        genre: lastGenre,
        year: lastYear,
        label: lastLabel,
        trackCount: lastTrackCount,
        albumDescription: lastAlbumDescription,
        artistBio: lastArtistBio,
        artistImage: lastArtistImage
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      return data.sessionId;
    }
  } catch (error) {
    console.error('Failed to create session:', error.message);
  }
  return null;
}

async function updateSession(media, isPlaying) {
  if (!currentSessionId) return;
  
  try {
    await fetch(`${store.get('apiBaseUrl')}/session/${currentSessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        song: lastCleanedSong || media.title,
        artist: lastCleanedArtist || media.artist,
        album: lastAlbumName || media.album || '',
        albumArt: lastAlbumArtUrl || '',
        duration: media.duration || 0,
        position: media.position || 0,
        playing: isPlaying,
        // Extended metadata from Gemini AI
        genre: lastGenre,
        year: lastYear,
        label: lastLabel,
        trackCount: lastTrackCount,
        albumDescription: lastAlbumDescription,
        artistBio: lastArtistBio,
        artistImage: lastArtistImage
      })
    });
  } catch (error) {
    // Silently fail - will retry on next poll
  }
}

async function endSession() {
  if (!currentSessionId) return;
  
  try {
    await fetch(`${store.get('apiBaseUrl')}/session/${currentSessionId}`, {
      method: 'DELETE'
    });
  } catch (error) {
    // Silently fail
  }
}

// ============ Discord Presence ============
function setDiscordPresence(media) {
  if (!discordClient || !discordClient.user) return;
  
  try {
    const now = Date.now();
    const startTimestamp = media.position ? now - (media.position * 1000) : now;
    const endTimestamp = media.duration ? startTimestamp + (media.duration * 1000) : null;
    
    // Use cleaned metadata for Discord presence
    const songTitle = lastCleanedSong || media.title;
    const artistName = lastCleanedArtist || media.artist;
    
    discordClient.request('SET_ACTIVITY', {
      pid: process.pid,
      activity: {
        type: 2, // 2 = Listening
        details: songTitle,
        state: `by ${artistName}`,
        timestamps: {
          start: Math.floor(startTimestamp / 1000),
          end: endTimestamp ? Math.floor(endTimestamp / 1000) : undefined
        },
        assets: {
          large_image: lastAlbumArtUrl || 'livia',
          large_text: lastAlbumName || media.album || 'Unknown Album',
          small_image: 'livia',
          small_text: 'Livia'
        },
        buttons: [
          { label: 'View on Livia', url: currentSessionUrl }
        ]
      }
    }).catch(err => console.log('RPC error:', err.message));
  } catch (error) {
    // Silently fail
  }
}

function clearDiscordPresence() {
  if (!discordClient) return;
  
  try {
    discordClient.clearActivity();
  } catch (error) {
    // Ignore
  }
}

// ============ Notifications ============
function showNotification(title, body) {
  if (!store.get('showNotifications')) return;
  
  if (Notification.isSupported()) {
    new Notification({ 
      title, 
      body, 
      silent: true,
      icon: process.platform === 'win32' ? path.join(__dirname, '..', 'assets', 'icon.ico') : undefined
    }).show();
  }
}

// ============ Utilities ============
function isPlaceholder(text) {
  if (!text) return true;
  const lower = text.toLowerCase().trim();
  return lower === 'connecting...' || 
         lower === 'loading...' || 
         lower === 'buffering...' ||
         lower === 'unknown' ||
         lower === 'advertisement' ||
         lower === 'ad' ||
         text.length < 2;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanup() {
  if (discordClient) {
    try {
      discordClient.destroy();
    } catch {}
  }
  if (tray) {
    tray.destroy();
  }
  if (hiddenWindow) {
    hiddenWindow.destroy();
  }
}

// ============ Uninstall ============
async function performUninstall() {
  const fs = require('fs');
  const { execSync } = require('child_process');
  
  try {
    // Show progress notification
    showNotification('Uninstalling Livia', 'Please wait...');
    
    // 1. Disable auto-launch
    try {
      const AutoLaunch = require('./auto-launch');
      const autoLauncher = new AutoLaunch();
      await autoLauncher.disable();
      console.log('Auto-launch disabled');
    } catch (err) {
      console.error('Failed to disable auto-launch:', err.message);
    }
    
    // 2. End any active session
    if (currentSessionId) {
      try {
        await endSession();
        console.log('Session ended');
      } catch (err) {
        console.error('Failed to end session:', err.message);
      }
    }
    
    // 3. Clear Discord presence
    clearDiscordPresence();
    
    // 4. Delete app data folder (%LOCALAPPDATA%\livia)
    const appDataPath = path.join(process.env.LOCALAPPDATA || '', 'livia');
    if (fs.existsSync(appDataPath)) {
      try {
        fs.rmSync(appDataPath, { recursive: true, force: true });
        console.log('App data deleted:', appDataPath);
      } catch (err) {
        console.error('Failed to delete app data:', err.message);
      }
    }
    
    // 5. Get the app installation path
    const appPath = app.getPath('exe');
    const appDir = path.dirname(appPath);
    
    // 6. Create a PowerShell script to delete the app after it closes
    // PowerShell runs hidden more reliably than batch files
    const psScript = `
$appDir = '${appDir.replace(/'/g, "''")}'

# Wait for app to fully exit
Start-Sleep -Seconds 3

# Force kill any remaining Livia processes
Get-Process -Name "Livia" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Wait after kill
Start-Sleep -Seconds 2

# Retry deletion up to 10 times
for ($i = 0; $i -lt 10; $i++) {
    try {
        if (Test-Path $appDir) {
            Remove-Item -Path $appDir -Recurse -Force -ErrorAction Stop
        }
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}

# Delete this script
Remove-Item -Path $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;
    
    const psPath = path.join(process.env.TEMP || '', 'livia-uninstall.ps1');
    fs.writeFileSync(psPath, psScript, 'utf8');
    
    // 7. Show completion message
    await dialog.showMessageBox(hiddenWindow, {
      type: 'info',
      title: 'Uninstall Complete',
      message: 'Livia has been uninstalled',
      detail: 'Thank you for using Livia! The app will now close and remove its files.',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    });
    
    // 8. Launch the cleanup PowerShell script (completely hidden) and quit
    if (process.platform === 'win32') {
      const { spawn } = require('child_process');
      // Use PowerShell with -WindowStyle Hidden to run completely silently
      const child = spawn('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', psPath
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    }
    
    // 9. Quit the app
    app.quit();
    
  } catch (error) {
    console.error('Uninstall error:', error);
    
    await dialog.showMessageBox(hiddenWindow, {
      type: 'error',
      title: 'Uninstall Failed',
      message: 'Failed to uninstall Livia completely',
      detail: `Error: ${error.message}\n\nYou may need to manually delete the app folder.`,
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    });
  }
}
