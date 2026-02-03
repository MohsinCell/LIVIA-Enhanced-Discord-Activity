/**
 * Cross-platform Media Detector
 * Detects currently playing music on Windows, macOS, and Linux
 */

const { exec, execSync } = require('child_process');
const util = require('util');
const path = require('path');
const execAsync = util.promisify(exec);

// Whitelisted music apps
const ALLOWED_APPS = new Set([
  'spotify', 'apple music', 'applemusic', 'music', 'itunes',
  'vlc', 'foobar2000', 'foobar', 'aimp', 'musicbee', 'winamp',
  'amazon music', 'amazonmusic', 'deezer', 'tidal', 'qobuz',
  'plexamp', 'plex', 'audirvana', 'roon', 'mediamonkey',
  'dopamine', 'clementine', 'strawberry', 'audacious',
  'groove music', 'windows media player', 'youtube music',
  'chrome', 'msedge', 'edge', 'firefox', 'brave', 'opera', // Browsers for web players
  'music.ui' // Windows 11 Media Player
]);

class MediaDetector {
  constructor() {
    this.platform = process.platform;
    this.lastMedia = null;
  }

  /**
   * Get currently playing media
   * @returns {Promise<Object|null>} Media info or null if nothing playing
   */
  async getCurrentMedia() {
    switch (this.platform) {
      case 'win32':
        return this.getWindowsMedia();
      case 'darwin':
        return this.getMacOSMedia();
      case 'linux':
        return this.getLinuxMedia();
      default:
        console.warn(`Unsupported platform: ${this.platform}`);
        return null;
    }
  }

  /**
   * Windows: Use PowerShell to query SMTC (System Media Transport Controls)
   */
  async getWindowsMedia() {
    // Use a separate PowerShell script file approach for better reliability
    const script = `
[System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime') | Out-Null

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
Function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

Function AwaitAction($WinRtAction) {
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and !$_.IsGenericMethod })[0]
    $netTask = $asTask.Invoke($null, @($WinRtAction))
    $netTask.Wait(-1) | Out-Null
}

try {
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
    
    # Load the extension method for converting WinRT streams to .NET streams
    Add-Type -AssemblyName 'System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089' -ErrorAction SilentlyContinue
    [System.IO.WindowsRuntimeStreamExtensions] | Out-Null
    
    $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    $session = $manager.GetCurrentSession()
    
    if ($null -eq $session) {
        Write-Output "NO_SESSION"
        exit
    }
    
    $mediaProps = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $playbackInfo = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()
    
    $status = switch ($playbackInfo.PlaybackStatus) {
        'Playing' { 'playing' }
        'Paused' { 'paused' }
        default { 'stopped' }
    }
    
    # Try to get thumbnail as base64
    $thumbnailBase64 = ""
    $thumbnailError = ""
    try {
        $thumbnail = $mediaProps.Thumbnail
        if ($null -ne $thumbnail) {
            $stream = Await ($thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
            $size = [uint32]$stream.Size
            
            if ($size -gt 0 -and $size -lt 10000000) {
                # Read stream into .NET MemoryStream
                $inputStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStream($stream)
                $memStream = New-Object System.IO.MemoryStream
                $inputStream.CopyTo($memStream)
                $bytes = $memStream.ToArray()
                $thumbnailBase64 = [Convert]::ToBase64String($bytes)
                $memStream.Close()
                $inputStream.Close()
            }
            # If size is 0, app doesn't provide thumbnails - that's OK, silently skip
        }
    } catch {
        # Thumbnail extraction failed - that's OK, continue without it
    }
    
    $result = @{
        app = $session.SourceAppUserModelId
        title = $mediaProps.Title
        artist = $mediaProps.Artist
        album = $mediaProps.AlbumTitle
        state = $status
        position = [int]$timeline.Position.TotalSeconds
        duration = [int]$timeline.EndTime.TotalSeconds
        thumbnail = $thumbnailBase64
    }
    
    $result | ConvertTo-Json -Compress
} catch {
    Write-Output "ERROR: $_"
}
`;

    try {
      // Write script to temp file and execute (more reliable than inline)
      const fs = require('fs');
      const os = require('os');
      const scriptPath = path.join(os.tmpdir(), 'livia-media-detect.ps1');
      fs.writeFileSync(scriptPath, script, 'utf8');
      
      const { stdout, stderr } = await execAsync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { timeout: 8000 }
      );

      const output = stdout.trim();
      
      // Debug logging
      if (output.startsWith('ERROR:')) {
        console.log('PowerShell error:', output);
        return null;
      }
      
      if (output === 'NO_SESSION' || !output) {
        return null;
      }

      const media = JSON.parse(output);
      
      // Debug: show what app was detected
      console.log(`Detected app: ${media.app}, title: ${media.title}`);
      if (media.thumbnail) {
        console.log(`Thumbnail: ${Math.round(media.thumbnail.length / 1024)}KB`);
      }
      
      // Check if app is whitelisted
      if (!this.isAllowedApp(media.app)) {
        console.log(`App "${media.app}" not in whitelist, skipping`);
        return null;
      }

      // Map app ID to friendly name
      media.app = this.getFriendlyAppName(media.app);
      
      return media;
    } catch (error) {
      // Silently fail - no media playing or PowerShell error
      return null;
    }
  }

  /**
   * macOS: Use AppleScript to get media info from various apps
   * No external dependencies required - works out of the box!
   */
  async getMacOSMedia() {
    // Try all supported apps in order of popularity
    
    // 1. Spotify (most common)
    const spotify = await this.getMacOSSpotify();
    if (spotify) return spotify;

    // 2. Apple Music
    const appleMusic = await this.getMacOSAppleMusic();
    if (appleMusic) return appleMusic;

    // 3. Try generic Now Playing info (works for many apps)
    const generic = await this.getMacOSGenericNowPlaying();
    if (generic) return generic;

    return null;
  }

  /**
   * macOS: Get generic Now Playing info using Media Remote framework
   * This catches apps that integrate with macOS media controls
   */
  async getMacOSGenericNowPlaying() {
    const script = `
      use framework "Foundation"
      use scripting additions
      
      -- Try to get info from the Now Playing menu bar
      tell application "System Events"
        try
          set frontApp to name of first application process whose frontmost is true
          -- Check common media apps
          set mediaApps to {"Deezer", "TIDAL", "Amazon Music", "YouTube Music", "Qobuz", "Audirvana", "Plexamp", "VLC"}
          repeat with appName in mediaApps
            if application appName is running then
              try
                tell application appName
                  return ""
                end tell
              end try
            end if
          end repeat
        end try
      end tell
      return ""
    `;

    try {
      // This is a fallback - most apps will be caught by Spotify/Apple Music handlers
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * macOS: Get Spotify media via AppleScript
   */
  async getMacOSSpotify() {
    const script = `
      if application "Spotify" is running then
        tell application "Spotify"
          if player state is playing or player state is paused then
            set trackName to name of current track
            set artistName to artist of current track
            set albumName to album of current track
            set trackDuration to duration of current track
            set trackPosition to player position
            set playerState to player state as string
            
            return trackName & "|||" & artistName & "|||" & albumName & "|||" & (trackDuration / 1000) & "|||" & trackPosition & "|||" & playerState
          end if
        end tell
      end if
      return ""
    `;

    try {
      const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 3000 });
      const output = stdout.trim();
      
      if (!output) return null;
      
      const [title, artist, album, duration, position, state] = output.split('|||');
      
      return {
        app: 'Spotify',
        title: title || '',
        artist: artist || '',
        album: album || '',
        state: state === 'playing' ? 'playing' : 'paused',
        position: Math.floor(parseFloat(position) || 0),
        duration: Math.floor(parseFloat(duration) || 0)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * macOS: Get Apple Music media via AppleScript
   */
  async getMacOSAppleMusic() {
    const script = `
      if application "Music" is running then
        tell application "Music"
          if player state is playing or player state is paused then
            set trackName to name of current track
            set artistName to artist of current track
            set albumName to album of current track
            set trackDuration to duration of current track
            set trackPosition to player position
            set playerState to player state as string
            
            return trackName & "|||" & artistName & "|||" & albumName & "|||" & trackDuration & "|||" & trackPosition & "|||" & playerState
          end if
        end tell
      end if
      return ""
    `;

    try {
      const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 3000 });
      const output = stdout.trim();
      
      if (!output) return null;
      
      const [title, artist, album, duration, position, state] = output.split('|||');
      
      return {
        app: 'Apple Music',
        title: title || '',
        artist: artist || '',
        album: album || '',
        state: state === 'playing' ? 'playing' : 'paused',
        position: Math.floor(parseFloat(position) || 0),
        duration: Math.floor(parseFloat(duration) || 0)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Linux: Use playerctl (MPRIS) for media detection
   */
  async getLinuxMedia() {
    try {
      // Check if any player is available
      const { stdout: players } = await execAsync('playerctl -l 2>/dev/null', { timeout: 2000 });
      
      if (!players.trim()) return null;
      
      // Get metadata from the first active player
      const commands = [
        'playerctl metadata --format "{{playerName}}|||{{title}}|||{{artist}}|||{{album}}|||{{mpris:length}}|||{{position}}|||{{status}}"'
      ];
      
      const { stdout } = await execAsync(commands[0], { timeout: 3000 });
      const output = stdout.trim();
      
      if (!output) return null;
      
      const [player, title, artist, album, lengthUs, positionUs, status] = output.split('|||');
      
      // Check if player is whitelisted
      if (!this.isAllowedApp(player)) return null;
      
      return {
        app: this.getFriendlyAppName(player),
        title: title || '',
        artist: artist || '',
        album: album || '',
        state: status.toLowerCase() === 'playing' ? 'playing' : 'paused',
        position: Math.floor(parseInt(positionUs || 0) / 1000000),
        duration: Math.floor(parseInt(lengthUs || 0) / 1000000)
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if an app is in our whitelist
   */
  isAllowedApp(appId) {
    if (!appId) return false;
    const lower = appId.toLowerCase();
    
    for (const allowed of ALLOWED_APPS) {
      if (lower.includes(allowed)) return true;
    }
    return false;
  }

  /**
   * Map app identifiers to friendly names
   */
  getFriendlyAppName(appId) {
    if (!appId) return 'Music';
    
    const lower = appId.toLowerCase();
    
    if (lower.includes('spotify')) return 'Spotify';
    if (lower.includes('com.apple.music') || lower === 'music') return 'Apple Music';
    if (lower.includes('applemusic')) return 'Apple Music';
    if (lower.includes('itunes')) return 'iTunes';
    if (lower.includes('vlc')) return 'VLC Media Player';
    if (lower.includes('foobar')) return 'foobar2000';
    if (lower.includes('aimp')) return 'AIMP';
    if (lower.includes('musicbee')) return 'MusicBee';
    if (lower.includes('winamp')) return 'Winamp';
    if (lower.includes('amazonmusic')) return 'Amazon Music';
    if (lower.includes('deezer')) return 'Deezer';
    if (lower.includes('tidal')) return 'TIDAL';
    if (lower.includes('qobuz')) return 'Qobuz';
    if (lower.includes('plexamp') || lower.includes('plex')) return 'Plex';
    if (lower.includes('youtube')) return 'YouTube Music';
    if (lower.includes('groove')) return 'Groove Music';
    if (lower.includes('dopamine')) return 'Dopamine';
    
    return 'Music Player';
  }
}

module.exports = MediaDetector;
