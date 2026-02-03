#nullable enable
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using DiscordRPC;
using DiscordRPC.Message;
using Microsoft.Win32;
using Newtonsoft.Json;
using Windows.Media.Control;

class Program
{
    static DiscordRpcClient client = null!;
    static readonly HttpClient http = new HttpClient();
    static NotifyIcon? trayIcon;
    static CancellationTokenSource? cts;

    // Discord user info (fetched from RPC connection)
    static string? discordUserId;
    static string? discordUsername;
    static string? discordDisplayName;
    static string? discordAvatarUrl;

    // Cache the last known valid duration per song
    static int lastKnownDuration = 0;

    // Cache album info by album+artist to ensure consistent artwork across tracks
    static readonly Dictionary<string, (string? artUrl, string? albumName, string? genre, int? year, int? trackCount, string? label)> albumInfoCache = new();

    // Configuration
    static AppConfig config = new AppConfig();
    static readonly string configPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Livia",
        "config.json"
    );

    static string GetAlbumCacheKey(string? albumName, string? artistName)
    {
        return $"{albumName?.ToLower().Trim()}-{artistName?.ToLower().Trim()}";
    }

    // WHITELIST: Only these apps will be tracked
    static readonly HashSet<string> AllowedApps = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "spotify",
        "applemusic",
        "apple music",
        "zune",           // Groove Music legacy
        "groove",
        "vlc",
        "foobar",
        "foobar2000",
        "aimp",
        "musicbee",
        "winamp",
        "itunes",
        "amazonmusic",
        "amazon music",
        "deezer",
        "tidal",
        "qobuz",
        "plexamp",
        "plex",
        "audirvana",
        "roon",
        "mediamonkey",
        "dopamine",       // Dopamine music player
        "clementine",
        "strawberry",     // Strawberry music player
        "audacious"
    };

    static Program()
    {
        // Set User-Agent for MusicBrainz API (required)
        http.DefaultRequestHeaders.Add("User-Agent", "Livia/1.0 (https://livia.mom)");
    }

    /// <summary>
    /// Check if the app is in our whitelist of music apps
    /// </summary>
    static bool IsAllowedMusicApp(string? appId)
    {
        if (string.IsNullOrWhiteSpace(appId)) return false;
        
        string appLower = appId.ToLower();
        return AllowedApps.Any(allowed => appLower.Contains(allowed.ToLower()));
    }

    /// <summary>
    /// Check if the text is a placeholder/loading state (not a real song)
    /// </summary>
    static bool IsPlaceholderText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return true;
        
        string lower = text.ToLower().Trim();
        
        // Common placeholder texts from various music apps
        return lower == "connecting..." 
            || lower == "connecting"
            || lower == "loading..."
            || lower == "loading"
            || lower == "buffering..."
            || lower == "buffering"
            || lower == "unknown"
            || lower == "unknown artist"
            || lower == "unknown title"
            || lower == "advertisement"
            || lower == "ad"
            || lower.StartsWith("connecting to")
            || lower.StartsWith("loading")
            || text.Length < 2;  // Single character is probably not a real song
    }

    [STAThread]
    static void Main()
    {
        // Ensure single instance
        using var mutex = new Mutex(true, "LiviaMusicActivity", out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show("Livia is already running in the system tray!", "Livia", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // Load configuration
        LoadConfig();

        // Initialize Discord RPC
        InitializeDiscord();

        // Setup system tray
        SetupSystemTray();

        // Start the main loop in a background thread
        cts = new CancellationTokenSource();
        Task.Run(() => MainLoop(cts.Token));

        // Run the Windows Forms message loop
        Application.Run();

        // Cleanup on exit
        Cleanup();
    }

    static void LoadConfig()
    {
        try
        {
            var configDir = Path.GetDirectoryName(configPath)!;
            if (!Directory.Exists(configDir))
            {
                Directory.CreateDirectory(configDir);
            }

            if (File.Exists(configPath))
            {
                var json = File.ReadAllText(configPath);
                config = JsonConvert.DeserializeObject<AppConfig>(json) ?? new AppConfig();
                Console.WriteLine("✅ Configuration loaded");
            }
            else
            {
                // Create default config
                SaveConfig();
                Console.WriteLine("✅ Default configuration created");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"⚠️ Failed to load config: {ex.Message}");
            config = new AppConfig();
        }
    }

    static void SaveConfig()
    {
        try
        {
            var configDir = Path.GetDirectoryName(configPath)!;
            if (!Directory.Exists(configDir))
            {
                Directory.CreateDirectory(configDir);
            }

            var json = JsonConvert.SerializeObject(config, Formatting.Indented);
            File.WriteAllText(configPath, json);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"⚠️ Failed to save config: {ex.Message}");
        }
    }

    static void InitializeDiscord()
    {
        client = new DiscordRpcClient(config.DiscordAppId);
        
        // Subscribe to events to get user info
        client.OnReady += (sender, e) =>
        {
            discordUserId = e.User.ID.ToString();
            discordUsername = e.User.Username;
            discordDisplayName = e.User.DisplayName ?? e.User.Username;
            
            // Construct avatar URL
            if (!string.IsNullOrEmpty(e.User.Avatar))
            {
                discordAvatarUrl = $"https://cdn.discordapp.com/avatars/{e.User.ID}/{e.User.Avatar}.png?size=256";
            }
            else
            {
                // Default Discord avatar
                var defaultAvatarIndex = (e.User.ID >> 22) % 6;
                discordAvatarUrl = $"https://cdn.discordapp.com/embed/avatars/{defaultAvatarIndex}.png";
            }

            Console.WriteLine($"");
            Console.WriteLine($"═══════════════════════════════════════════════");
            Console.WriteLine($"  🎵 LIVIA - Music Activity Display");
            Console.WriteLine($"═══════════════════════════════════════════════");
            Console.WriteLine($"  Connected as: {discordDisplayName} (@{discordUsername})");
            Console.WriteLine($"  User ID: {discordUserId}");
            Console.WriteLine($"  Avatar: {(string.IsNullOrEmpty(e.User.Avatar) ? "Default" : "Custom")}");
            Console.WriteLine($"═══════════════════════════════════════════════");
            Console.WriteLine($"");
            Console.WriteLine($"📋 Whitelisted apps: {string.Join(", ", AllowedApps.Take(8))}...");
            Console.WriteLine($"🔧 Running in system tray - right-click tray icon for options");
            Console.WriteLine($"");

            // Update tray tooltip with username
            if (trayIcon != null)
            {
                trayIcon.Text = $"Livia - {discordDisplayName}";
            }
        };

        client.OnConnectionFailed += (sender, e) =>
        {
            Console.WriteLine($"❌ Discord connection failed. Is Discord running?");
            ShowNotification("Connection Failed", "Could not connect to Discord. Make sure Discord is running.");
        };

        client.Initialize();
    }

    static void SetupSystemTray()
    {
        // Create context menu
        var contextMenu = new ContextMenuStrip();
        
        var statusItem = new ToolStripMenuItem("Status: Connecting...");
        statusItem.Enabled = false;
        contextMenu.Items.Add(statusItem);
        
        contextMenu.Items.Add(new ToolStripSeparator());
        
        var startupItem = new ToolStripMenuItem("Start with Windows");
        startupItem.Checked = config.StartWithWindows;
        startupItem.Click += (s, e) =>
        {
            config.StartWithWindows = !config.StartWithWindows;
            startupItem.Checked = config.StartWithWindows;
            SetStartup(config.StartWithWindows);
            SaveConfig();
        };
        contextMenu.Items.Add(startupItem);
        
        var notificationsItem = new ToolStripMenuItem("Show Notifications");
        notificationsItem.Checked = config.ShowNotifications;
        notificationsItem.Click += (s, e) =>
        {
            config.ShowNotifications = !config.ShowNotifications;
            notificationsItem.Checked = config.ShowNotifications;
            SaveConfig();
        };
        contextMenu.Items.Add(notificationsItem);
        
        contextMenu.Items.Add(new ToolStripSeparator());
        
        var openWebItem = new ToolStripMenuItem("Open Livia Website");
        openWebItem.Click += (s, e) =>
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "https://livia.mom",
                UseShellExecute = true
            });
        };
        contextMenu.Items.Add(openWebItem);
        
        contextMenu.Items.Add(new ToolStripSeparator());
        
        var exitItem = new ToolStripMenuItem("Exit Livia");
        exitItem.Click += (s, e) =>
        {
            Application.Exit();
        };
        contextMenu.Items.Add(exitItem);

        // Create tray icon
        trayIcon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Visible = true,
            Text = "Livia - Connecting...",
            ContextMenuStrip = contextMenu
        };

        trayIcon.DoubleClick += (s, e) =>
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "https://livia.mom",
                UseShellExecute = true
            });
        };
    }

    static Icon LoadTrayIcon()
    {
        try
        {
            // Try to load custom icon from app directory
            var iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "livia.ico");
            if (File.Exists(iconPath))
            {
                return new Icon(iconPath);
            }
        }
        catch { }

        // Fallback to system icon
        return SystemIcons.Application;
    }

    static void SetStartup(bool enable)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", true);
            if (key != null)
            {
                if (enable)
                {
                    var exePath = Application.ExecutablePath;
                    key.SetValue("Livia", $"\"{exePath}\"");
                    Console.WriteLine("✅ Added to Windows startup");
                }
                else
                {
                    key.DeleteValue("Livia", false);
                    Console.WriteLine("✅ Removed from Windows startup");
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"⚠️ Failed to modify startup: {ex.Message}");
        }
    }

    static void ShowNotification(string title, string message)
    {
        if (trayIcon != null && config.ShowNotifications)
        {
            trayIcon.ShowBalloonTip(3000, title, message, ToolTipIcon.Info);
        }
    }

    static void UpdateTrayStatus(string status)
    {
        if (trayIcon?.ContextMenuStrip?.Items[0] is ToolStripMenuItem item)
        {
            item.Text = $"Status: {status}";
        }
    }

    static void Cleanup()
    {
        cts?.Cancel();
        client?.Dispose();
        trayIcon?.Dispose();
    }

    static async Task MainLoop(CancellationToken cancellationToken)
    {
        string lastSongId = "";
        string? lastAlbumArtUrl = null;
        string? lastAlbumName = null;

        // Track current app session
        string? currentAppId = null;
        string? currentSessionId = null;
        string currentSessionUrl = "https://livia.mom/";
        bool lastPlayingState = false;

        // Discord presence timestamp tracking
        DateTime? presenceStartTime = null;
        DateTime? presenceEndTime = null;

        while (!cancellationToken.IsCancellationRequested)
        {
            bool presenceSet = false;
            bool isPlaying = false;

            try
            {
                var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                var sessions = manager.GetSessions();

                string? activeAppId = null;
                GlobalSystemMediaTransportControlsSession? activeSession = null;

                // Find the currently playing OR paused app (only from whitelisted apps)
                foreach (var session in sessions)
                {
                    string sessionAppId = session.SourceAppUserModelId;
                    
                    // WHITELIST CHECK: Skip if not an allowed music app
                    if (!IsAllowedMusicApp(sessionAppId))
                    {
                        continue;
                    }

                    var playback = session.GetPlaybackInfo();

                    if (playback.PlaybackStatus ==
                        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                    {
                        activeAppId = sessionAppId;
                        activeSession = session;
                        isPlaying = true;
                        break;
                    }
                    // Also track paused sessions if no playing session found
                    else if (activeSession == null &&
                             playback.PlaybackStatus ==
                             GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused)
                    {
                        activeAppId = sessionAppId;
                        activeSession = session;
                        isPlaying = false;
                    }
                }

                // Check if app changed or stopped completely
                if (activeAppId != currentAppId)
                {
                    // End previous session if exists
                    if (currentSessionId != null)
                    {
                        Console.WriteLine($"🛑 Ending session for {GetFriendlyAppName(currentAppId)}: {currentSessionId}");
                        await EndSession(currentSessionId);
                        currentSessionId = null;
                        UpdateTrayStatus("Idle");
                    }

                    // Start new session if there's an active app
                    if (activeAppId != null && activeSession != null)
                    {
                        string appName = GetFriendlyAppName(activeAppId);
                        Console.WriteLine($"\n🎧 Started listening on {appName}");

                        var media = await activeSession.TryGetMediaPropertiesAsync();
                        
                        // Skip if placeholder/loading text
                        if (IsPlaceholderText(media.Title) || IsPlaceholderText(media.Artist))
                        {
                            Console.WriteLine($"⏳ Skipping placeholder: {media.Title} - waiting for real song data...");
                            currentAppId = activeAppId;
                            lastPlayingState = isPlaying;
                            await Task.Delay(1000, cancellationToken);
                            continue;
                        }

                        var timeline = activeSession.GetTimelineProperties();

                        // Get valid duration with retry logic
                        int duration = await GetValidDuration(activeSession, timeline);

                        // Fetch album info - pass system album name for better accuracy
                        var albumInfo = await GetAlbumInfo(media.Title, media.Artist, media.AlbumTitle);
                        lastAlbumArtUrl = albumInfo.artUrl;
                        lastAlbumName = albumInfo.albumName ?? media.AlbumTitle;

                        Console.WriteLine($"🎵 Initial Song: {media.Title} - {media.Artist}");
                        Console.WriteLine($"💿 Album: {lastAlbumName ?? "Unknown"}");
                        if (!string.IsNullOrWhiteSpace(albumInfo.genre))
                            Console.WriteLine($"🎸 Genre: {albumInfo.genre}");
                        if (albumInfo.year != null)
                            Console.WriteLine($"📅 Year: {albumInfo.year}");
                        if (albumInfo.trackCount != null)
                            Console.WriteLine($"🎼 Tracks: {albumInfo.trackCount}");
                        if (!string.IsNullOrWhiteSpace(albumInfo.label))
                            Console.WriteLine($"🏷️ Label: {albumInfo.label}");
                        Console.WriteLine($"⏱️ Duration: {duration} seconds");

                        // Create new session WITH complete initial data INCLUDING user info
                        currentSessionId = await CreateSession(
                            appName,
                            media.Title,
                            media.Artist,
                            lastAlbumName ?? media.AlbumTitle ?? "",
                            lastAlbumArtUrl ?? "",
                            duration,
                            (int)timeline.Position.TotalSeconds,
                            isPlaying
                        );

                        if (currentSessionId != null)
                        {
                            // Give backend time to register session
                            await Task.Delay(500, cancellationToken);

                            currentSessionUrl = $"https://livia.mom/s/{currentSessionId}";
                            Console.WriteLine($"✅ Session Created: {currentSessionId}");
                            Console.WriteLine($"🔗 Full URL: {currentSessionUrl}\n");

                            // Mark this song as "seen" so we don't refetch immediately
                            lastSongId = $"{media.Title}|{media.Artist}";
                            
                            UpdateTrayStatus($"Playing on {appName}");
                            ShowNotification("Now Playing", $"{media.Title} - {media.Artist}");
                        }
                        else
                        {
                            currentSessionUrl = "https://livia.mom/";
                            Console.WriteLine("❌ Failed to create session - using fallback URL\n");
                        }

                        lastPlayingState = isPlaying;

                        // Reset Discord timestamps for new song
                        presenceStartTime = null;
                        presenceEndTime = null;
                    }
                    else
                    {
                        Console.WriteLine("⏸️ Stopped listening\n");
                        currentSessionUrl = "https://livia.mom/";
                        // Reset cached duration when stopping
                        lastKnownDuration = 0;
                        UpdateTrayStatus("Idle");
                    }

                    currentAppId = activeAppId;
                }

                // Handle play/pause state changes
                if (activeSession != null && currentSessionId != null && isPlaying != lastPlayingState)
                {
                    Console.WriteLine(isPlaying ? "▶️ Resumed playback" : "⏸️ Paused playback");

                    var media = await activeSession.TryGetMediaPropertiesAsync();
                    var timeline = activeSession.GetTimelineProperties();

                    // Get valid duration
                    int duration = await GetValidDuration(activeSession, timeline);

                    await UpdateSession(
                        currentSessionId,
                        media.Title,
                        media.Artist,
                        lastAlbumName ?? media.AlbumTitle ?? "",
                        lastAlbumArtUrl ?? "",
                        duration,
                        (int)timeline.Position.TotalSeconds,
                        isPlaying
                    );

                    lastPlayingState = isPlaying;
                    
                    string appName = GetFriendlyAppName(activeAppId);
                    UpdateTrayStatus(isPlaying ? $"Playing on {appName}" : "Paused");

                    // Reset Discord timestamps when play state changes
                    presenceStartTime = null;
                    presenceEndTime = null;
                }

                // Update Discord presence and send heartbeat
                if (activeSession != null)
                {
                    var media = await activeSession.TryGetMediaPropertiesAsync();

                    // Filter out placeholder/loading states from Apple Music and other apps
                    bool isValidSong = !string.IsNullOrWhiteSpace(media.Title) 
                        && !IsPlaceholderText(media.Title)
                        && !IsPlaceholderText(media.Artist);

                    if (isValidSong)
                    {
                        var timeline = activeSession.GetTimelineProperties();
                        string currentSongId = $"{media.Title}|{media.Artist}";

                        // Get valid duration for all cases
                        int duration = await GetValidDuration(activeSession, timeline);

                        // Update album art and song info when song changes
                        if (currentSongId != lastSongId)
                        {
                            Console.WriteLine($"🎵 Now Playing: {media.Title} - {media.Artist}");
                            Console.WriteLine($"⏱️ Duration: {duration} seconds");
                            lastSongId = currentSongId;

                            // Reset cached duration for new song
                            lastKnownDuration = duration;

                            var albumInfo = await GetAlbumInfo(media.Title, media.Artist, media.AlbumTitle);
                            lastAlbumArtUrl = albumInfo.artUrl;
                            lastAlbumName = albumInfo.albumName ?? media.AlbumTitle;

                            Console.WriteLine($"💿 Album: {lastAlbumName ?? "Unknown"}");
                            if (!string.IsNullOrWhiteSpace(albumInfo.genre))
                                Console.WriteLine($"🎸 Genre: {albumInfo.genre}");
                            if (albumInfo.year != null)
                                Console.WriteLine($"📅 Year: {albumInfo.year}");
                            if (albumInfo.trackCount != null)
                                Console.WriteLine($"🎼 Tracks: {albumInfo.trackCount}");
                            if (!string.IsNullOrWhiteSpace(albumInfo.label))
                                Console.WriteLine($"🏷️ Label: {albumInfo.label}");

                            // Update session with current song info
                            if (currentSessionId != null)
                            {
                                await UpdateSession(
                                    currentSessionId,
                                    media.Title,
                                    media.Artist,
                                    lastAlbumName ?? media.AlbumTitle ?? "",
                                    lastAlbumArtUrl ?? "",
                                    duration,
                                    (int)timeline.Position.TotalSeconds,
                                    isPlaying
                                );
                                
                                ShowNotification("Now Playing", $"{media.Title} - {media.Artist}");
                            }

                            // Reset Discord timestamps for new song
                            presenceStartTime = null;
                            presenceEndTime = null;
                        }
                        // Send heartbeat with current position
                        else if (currentSessionId != null)
                        {
                            await UpdateSession(
                                currentSessionId,
                                media.Title,
                                media.Artist,
                                lastAlbumName ?? media.AlbumTitle ?? "",
                                lastAlbumArtUrl ?? "",
                                duration,
                                (int)timeline.Position.TotalSeconds,
                                isPlaying
                            );
                        }

                        // Show presence only when actually playing
                        if (isPlaying)
                        {
                            // Only recalculate timestamps if not set or song changed
                            // Also recalculate if duration was 0 before but now we have valid duration
                            if (presenceStartTime == null || presenceEndTime == null || 
                                (presenceEndTime.Value <= presenceStartTime.Value && duration > 0))
                            {
                                var now = DateTime.UtcNow;
                                presenceStartTime = now - timeline.Position;
                                
                                // Only set end time if we have valid duration
                                if (duration > 0)
                                {
                                    presenceEndTime = presenceStartTime.Value + TimeSpan.FromSeconds(duration);
                                }
                                else
                                {
                                    // Fallback: estimate 3 minutes if no duration available
                                    presenceEndTime = presenceStartTime.Value + TimeSpan.FromMinutes(3);
                                    Console.WriteLine("⚠️ Duration still 0, using 3 min fallback for Discord");
                                }
                            }

                            string appName = GetFriendlyAppName(activeAppId);

                            client.SetPresence(new RichPresence
                            {
                                Details = $"{media.Title}",
                                State = $"By {media.Artist}",

                                Timestamps = new Timestamps
                                {
                                    Start = presenceStartTime.Value,
                                    End = presenceEndTime.Value
                                },

                                Assets = new Assets
                                {
                                    LargeImageKey = lastAlbumArtUrl ?? "livia",
                                    LargeImageText = lastAlbumName ?? media.AlbumTitle,

                                    SmallImageKey = "livia",
                                    SmallImageText = "LIVIA"
                                },

                                Buttons = new DiscordRPC.Button[]
                                {
                                    new DiscordRPC.Button() { Label = "View on Livia", Url = currentSessionUrl }
                                },

                                Type = ActivityType.Listening

                            });

                            presenceSet = true;
                        }
                        else
                        {
                            // Paused - clear Discord presence
                            client.ClearPresence();
                        }
                    }
                }

                if (!presenceSet)
                {
                    client.ClearPresence();
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error: {ex.Message}");
            }

            // Adaptive polling: faster when playing, slower when paused
            try
            {
                if (isPlaying)
                {
                    await Task.Delay(3000, cancellationToken); // Poll every 3s when playing
                }
                else
                {
                    await Task.Delay(10000, cancellationToken); // Poll every 10s when paused
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    /// <summary>
    /// Gets a valid duration, retrying if necessary and using cached value as fallback.
    /// Handles the race condition where timeline.EndTime can temporarily be 0.
    /// </summary>
    static async Task<int> GetValidDuration(
        GlobalSystemMediaTransportControlsSession session, 
        GlobalSystemMediaTransportControlsSessionTimelineProperties timeline)
    {
        int duration = (int)timeline.EndTime.TotalSeconds;

        // If we got a valid duration, cache it and return
        if (duration > 0)
        {
            lastKnownDuration = duration;
            return duration;
        }

        // Duration is 0 - try to get it with a small delay (API timing issue)
        Console.WriteLine("⚠️ Duration was 0, retrying...");
        
        // Try up to 3 times with small delays
        for (int attempt = 0; attempt < 3; attempt++)
        {
            await Task.Delay(100 * (attempt + 1)); // 100ms, 200ms, 300ms delays
            
            var newTimeline = session.GetTimelineProperties();
            duration = (int)newTimeline.EndTime.TotalSeconds;
            
            if (duration > 0)
            {
                Console.WriteLine($"✅ Got valid duration on retry {attempt + 1}: {duration}s");
                lastKnownDuration = duration;
                return duration;
            }
        }

        // Still 0 - use cached duration if available
        if (lastKnownDuration > 0)
        {
            Console.WriteLine($"⚠️ Using cached duration: {lastKnownDuration}s");
            return lastKnownDuration;
        }

        // No cached value - return 0 (will be handled by caller)
        Console.WriteLine("⚠️ Could not get valid duration, returning 0");
        return 0;
    }

    // CREATE SESSION WITH COMPLETE INITIAL DATA INCLUDING USER INFO
    static async Task<string?> CreateSession(
        string app,
        string song,
        string artist,
        string album,
        string albumArt,
        int duration,
        int position,
        bool playing)
    {
        try
        {
            var payload = new
            {
                app,
                song,
                artist,
                album,
                albumArt,
                duration,
                position,
                playing,
                // User info from Discord RPC
                user = new
                {
                    id = discordUserId,
                    username = discordUsername,
                    displayName = discordDisplayName,
                    avatarUrl = discordAvatarUrl
                }
            };

            var json = JsonConvert.SerializeObject(payload);
            var content = new StringContent(json, Encoding.UTF8, "application/json");

            Console.WriteLine($"📤 Creating session for {app} with song data...");

            var res = await http.PostAsync(
                $"{config.ApiBaseUrl}/session",
                content
            );

            if (!res.IsSuccessStatusCode)
            {
                Console.WriteLine($"❌ Session creation failed: {res.StatusCode}");
                var errorBody = await res.Content.ReadAsStringAsync();
                Console.WriteLine($"   Error details: {errorBody}");
                return null;
            }

            var body = await res.Content.ReadAsStringAsync();
            Console.WriteLine($"📥 Backend response: {body}");

            dynamic? data = JsonConvert.DeserializeObject(body);

            return data?.sessionId;
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"🌐 Network error during session creation: {ex.Message}");
            Console.WriteLine("⚠️ Will retry on next poll...");
            return null;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"⚠️ Session creation error: {ex.Message}");
            return null;
        }
    }

    // UPDATE SESSION with current song info, playing state, and position
    static async Task UpdateSession(
        string sessionId,
        string song,
        string artist,
        string album,
        string albumArt,
        int duration,
        int position,
        bool playing)
    {
        try
        {
            var payload = new
            {
                song,
                artist,
                album,
                albumArt,
                duration,
                position,
                playing
            };

            var json = JsonConvert.SerializeObject(payload);
            var content = new StringContent(json, Encoding.UTF8, "application/json");

            var res = await http.PutAsync(
                $"{config.ApiBaseUrl}/session/{sessionId}",
                content
            );

            // Check if session was lost (404/410)
            if (res.StatusCode == System.Net.HttpStatusCode.NotFound ||
                res.StatusCode == System.Net.HttpStatusCode.Gone)
            {
                Console.WriteLine("⚠️ Session lost on backend, will recreate on next app change...");
            }
            else if (!res.IsSuccessStatusCode)
            {
                Console.WriteLine($"⚠️ Session update returned {res.StatusCode}");
            }
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"🌐 Network error during session update: {ex.Message}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"⚠️ Session update error: {ex.Message}");
        }
    }

    // END SESSION when app closes or switches
    static async Task EndSession(string sessionId)
    {
        try
        {
            var res = await http.DeleteAsync($"{config.ApiBaseUrl}/session/{sessionId}");

            if (!res.IsSuccessStatusCode)
            {
                Console.WriteLine($"⚠️ Session end returned {res.StatusCode}");
            }
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"🌐 Network error during session end: {ex.Message}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"⚠️ Session end error: {ex.Message}");
        }
    }


    // Last.fm API key
    static readonly string LastFmApiKey = "d46e4b5b41f47257307e0852fefdd5b0";

    /// <summary>
    /// Fetch album art and metadata using Last.fm as primary source, iTunes as fallback.
    /// Album NAME should come from the media session (more reliable), not from API lookup.
    /// </summary>
    static async Task<(string? artUrl, string? albumName, string? genre, int? year, int? trackCount, string? label)> GetAlbumInfo(string song, string artist, string? systemAlbumName = null)
    {
        // Check cache first - ensures consistent artwork for same album
        string cacheKey = GetAlbumCacheKey(systemAlbumName, artist);
        if (!string.IsNullOrWhiteSpace(systemAlbumName) && albumInfoCache.TryGetValue(cacheKey, out var cachedInfo))
        {
            Console.WriteLine($"📦 Using cached album info for: {systemAlbumName}");
            return cachedInfo;
        }

        string? albumName = systemAlbumName; // Prefer the album name from the media session
        string? artUrl = null;
        string? genre = null;
        string? label = null;
        int? year = null;
        int? trackCount = null;

        // Clean the artist name for searching (removes "— Album Name" suffix from Apple Music)
        string cleanedArtist = artist;
        string? extractedAlbumName = null;
        
        if (artist.Contains("—"))
        {
            var parts = artist.Split("—");
            cleanedArtist = parts[0].Trim();
            if (parts.Length > 1)
            {
                extractedAlbumName = parts[1].Trim();
            }
        }
        else if (artist.Contains(" - "))
        {
            var parts = artist.Split(" - ");
            cleanedArtist = parts[0].Trim();
            if (parts.Length > 1)
            {
                extractedAlbumName = parts[1].Trim();
            }
        }

        // If systemAlbumName is empty but we extracted one from artist, use that
        if (string.IsNullOrWhiteSpace(albumName) && !string.IsNullOrWhiteSpace(extractedAlbumName))
        {
            albumName = extractedAlbumName;
            Console.WriteLine($"📀 Extracted album name from artist field: {albumName}");
        }

        // ========== PRIMARY: Last.fm API ==========
        try
        {
            if (!string.IsNullOrWhiteSpace(albumName))
            {
                Console.WriteLine($"🔍 Last.fm: Searching for album '{albumName}' by '{cleanedArtist}'");

                var lastfmUrl = $"https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist={Uri.EscapeDataString(cleanedArtist)}&album={Uri.EscapeDataString(albumName)}&api_key={LastFmApiKey}&format=json";
                
                var lastfmJson = await http.GetStringAsync(lastfmUrl);
                dynamic? lastfmData = JsonConvert.DeserializeObject(lastfmJson);

                if (lastfmData?.album != null)
                {
                    var albumData = lastfmData.album;
                    Console.WriteLine($"✅ Last.fm album found: {albumData.name}");

                    // Get track count
                    var tracks = albumData.tracks?.track;
                    if (tracks != null)
                    {
                        if (tracks.Type == Newtonsoft.Json.Linq.JTokenType.Array)
                        {
                            trackCount = tracks.Count;
                        }
                        else
                        {
                            // Single track (not an array)
                            trackCount = 1;
                        }
                        Console.WriteLine($"✅ Last.fm track count: {trackCount}");
                    }

                    // Get tags/genres
                    var tags = albumData.tags?.tag;
                    if (tags != null && tags.Count > 0)
                    {
                        // Get first tag as genre
                        if (tags.Type == Newtonsoft.Json.Linq.JTokenType.Array)
                        {
                            genre = (string?)tags[0]?.name;
                        }
                        else
                        {
                            genre = (string?)tags.name;
                        }
                        if (!string.IsNullOrWhiteSpace(genre))
                        {
                            Console.WriteLine($"✅ Last.fm genre: {genre}");
                        }
                    }

                    // Get artwork from Last.fm
                    var images = albumData.image;
                    if (images != null && images.Count > 0)
                    {
                        // Find the largest image (mega or extralarge)
                        foreach (var img in images)
                        {
                            string? size = (string?)img.size;
                            string? url = (string?)img["#text"];
                            
                            if (size == "mega" && !string.IsNullOrWhiteSpace(url))
                            {
                                artUrl = url;
                                break;
                            }
                            else if (size == "extralarge" && !string.IsNullOrWhiteSpace(url))
                            {
                                artUrl = url;
                            }
                            else if (size == "large" && string.IsNullOrWhiteSpace(artUrl) && !string.IsNullOrWhiteSpace(url))
                            {
                                artUrl = url;
                            }
                        }

                        // Check for Last.fm placeholder image
                        if (artUrl != null && (artUrl.Contains("2a96cbd8b46e442fc41c2b86b821562f") || string.IsNullOrWhiteSpace(artUrl)))
                        {
                            artUrl = null;
                        }

                        if (artUrl != null)
                        {
                            Console.WriteLine($"✅ Last.fm artwork found");
                        }
                    }
                }
                else if (lastfmData?.error != null)
                {
                    Console.WriteLine($"⚠️ Last.fm album not found: {lastfmData.message}");
                }
            }
            else
            {
                // No album name - try searching by track
                Console.WriteLine($"🔍 Last.fm: Searching for track '{song}' by '{cleanedArtist}'");

                var trackUrl = $"https://ws.audioscrobbler.com/2.0/?method=track.getinfo&artist={Uri.EscapeDataString(cleanedArtist)}&track={Uri.EscapeDataString(song)}&api_key={LastFmApiKey}&format=json";
                
                var trackJson = await http.GetStringAsync(trackUrl);
                dynamic? trackData = JsonConvert.DeserializeObject(trackJson);

                if (trackData?.track?.album != null)
                {
                    var albumData = trackData.track.album;
                    albumName = (string?)albumData.title;
                    
                    if (!string.IsNullOrWhiteSpace(albumName))
                    {
                        Console.WriteLine($"✅ Last.fm found album from track: {albumName}");

                        // Get artwork from album info in track response
                        var images = albumData.image;
                        if (images != null && images.Count > 0)
                        {
                            foreach (var img in images)
                            {
                                string? size = (string?)img.size;
                                string? url = (string?)img["#text"];
                                
                                if (size == "mega" && !string.IsNullOrWhiteSpace(url))
                                {
                                    artUrl = url;
                                    break;
                                }
                                else if (size == "extralarge" && !string.IsNullOrWhiteSpace(url))
                                {
                                    artUrl = url;
                                }
                                else if (size == "large" && string.IsNullOrWhiteSpace(artUrl) && !string.IsNullOrWhiteSpace(url))
                                {
                                    artUrl = url;
                                }
                            }

                            // Check for placeholder
                            if (artUrl != null && (artUrl.Contains("2a96cbd8b46e442fc41c2b86b821562f") || string.IsNullOrWhiteSpace(artUrl)))
                            {
                                artUrl = null;
                            }
                        }
                    }
                }

                // Get genre from track tags if we don't have one
                if (string.IsNullOrWhiteSpace(genre) && trackData?.track?.toptags?.tag != null)
                {
                    var tags = trackData.track.toptags.tag;
                    if (tags.Count > 0)
                    {
                        if (tags.Type == Newtonsoft.Json.Linq.JTokenType.Array)
                        {
                            genre = (string?)tags[0]?.name;
                        }
                        else
                        {
                            genre = (string?)tags.name;
                        }
                        if (!string.IsNullOrWhiteSpace(genre))
                        {
                            Console.WriteLine($"✅ Last.fm genre from track: {genre}");
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"⚠️ Last.fm search failed: {ex.Message}");
        }

        // ========== FALLBACK: iTunes API for artwork and additional metadata ==========
        if (artUrl == null || year == null)
        {
            try
            {
                // Use system album name if available for better iTunes matching
                var searchTerm = !string.IsNullOrWhiteSpace(albumName) 
                    ? $"{cleanedArtist} {albumName}"
                    : $"{song} {cleanedArtist}";
                var query = Uri.EscapeDataString(searchTerm);
                var url = $"https://itunes.apple.com/search?term={query}&entity=album&limit=5";

                Console.WriteLine($"🔍 Fetching iTunes metadata for: {searchTerm}");

                var itunesJson = await http.GetStringAsync(url);
                dynamic? data = JsonConvert.DeserializeObject(itunesJson);

                var results = data?.results;
                if (data?.resultCount > 0 && results != null && results.Count > 0)
                {
                    // Find best match
                    dynamic? bestMatch = null;
                    int highestScore = 0;

                    foreach (var result in results)
                    {
                        if (result == null) continue;
                        int score = 0;

                        string? resultAlbum = (string?)result.collectionName;
                        string? resultArtist = (string?)result.artistName;
                        int? resultTrackCount = (int?)result.trackCount;

                        // Album name match
                        if (!string.IsNullOrWhiteSpace(albumName) && !string.IsNullOrWhiteSpace(resultAlbum))
                        {
                            if (resultAlbum.Equals(albumName, StringComparison.OrdinalIgnoreCase))
                                score += 100;
                            else if (resultAlbum.ToLower().Contains(albumName.ToLower()) || albumName.ToLower().Contains(resultAlbum.ToLower()))
                                score += 50;
                        }

                        // Artist match
                        if (!string.IsNullOrWhiteSpace(resultArtist))
                        {
                            if (resultArtist.Equals(cleanedArtist, StringComparison.OrdinalIgnoreCase))
                                score += 100;
                            else if (resultArtist.ToLower().Contains(cleanedArtist.ToLower()) || cleanedArtist.ToLower().Contains(resultArtist.ToLower()))
                                score += 50;
                        }

                        // Prefer full albums
                        if (resultTrackCount != null && resultTrackCount >= 8)
                            score += 30;

                        if (score > highestScore)
                        {
                            highestScore = score;
                            bestMatch = result;
                        }
                    }

                    if (bestMatch != null && highestScore >= 50)
                    {
                        Console.WriteLine($"✅ iTunes match: {bestMatch.collectionName} by {bestMatch.artistName} (score: {highestScore})");

                        // Get artwork if we don't have it
                        if (artUrl == null)
                        {
                            string? itunesArt = (string?)bestMatch.artworkUrl100;
                            if (!string.IsNullOrWhiteSpace(itunesArt))
                            {
                                artUrl = itunesArt.Replace("100x100", "600x600");
                                Console.WriteLine($"✅ iTunes artwork: Found");
                            }
                        }

                        // Get album name if we still don't have one
                        if (string.IsNullOrWhiteSpace(albumName))
                        {
                            albumName = (string?)bestMatch.collectionName;
                            if (albumName != null)
                            {
                                Console.WriteLine($"✅ iTunes album name: {albumName}");
                            }
                        }

                        // Get genre from iTunes if we don't have one
                        if (string.IsNullOrWhiteSpace(genre))
                        {
                            genre = (string?)bestMatch.primaryGenreName;
                            if (!string.IsNullOrWhiteSpace(genre))
                            {
                                Console.WriteLine($"✅ iTunes genre: {genre}");
                            }
                        }

                        // Get year from iTunes
                        if (year == null)
                        {
                            string? releaseDate = (string?)bestMatch.releaseDate;
                            if (!string.IsNullOrWhiteSpace(releaseDate) && releaseDate.Length >= 4)
                            {
                                if (int.TryParse(releaseDate.Substring(0, 4), out int parsedYear))
                                {
                                    year = parsedYear;
                                    Console.WriteLine($"✅ iTunes year: {year}");
                                }
                            }
                        }

                        // Get track count from iTunes if we don't have one
                        if (trackCount == null)
                        {
                            trackCount = (int?)bestMatch.trackCount;
                            if (trackCount != null)
                            {
                                Console.WriteLine($"✅ iTunes track count: {trackCount}");
                            }
                        }

                        // Get label/copyright from iTunes
                        if (string.IsNullOrWhiteSpace(label))
                        {
                            label = (string?)bestMatch.copyright;
                            if (!string.IsNullOrWhiteSpace(label))
                            {
                                Console.WriteLine($"✅ iTunes label/copyright: {label}");
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"⚠️ iTunes fallback failed: {ex.Message}");
            }
        }

        // Cache the result for consistent artwork across tracks from same album
        var albumResult = (artUrl, albumName, genre, year, trackCount, label);
        if (!string.IsNullOrWhiteSpace(albumName))
        {
            string finalCacheKey = GetAlbumCacheKey(albumName, artist);
            albumInfoCache[finalCacheKey] = albumResult;
            Console.WriteLine($"💾 Cached album info for: {albumName}");

            // Keep cache size reasonable (max 50 albums)
            if (albumInfoCache.Count > 50)
            {
                var firstKey = albumInfoCache.Keys.First();
                albumInfoCache.Remove(firstKey);
            }
        }

        return albumResult;
    }
    // Map app IDs to friendly names
    static string GetFriendlyAppName(string? appId)
    {
        if (string.IsNullOrWhiteSpace(appId))
            return "Music";

        appId = appId.ToLower();

        if (appId.Contains("spotify")) return "Spotify";
        if (appId.Contains("applemusic")) return "Apple Music";
        if (appId.Contains("youtube")) return "YouTube Music";
        if (appId.Contains("vlc")) return "VLC Media Player";
        if (appId.Contains("groove") || appId.Contains("zune")) return "Groove Music";
        if (appId.Contains("windowsmedia")) return "Windows Media Player";
        if (appId.Contains("foobar")) return "foobar2000";
        if (appId.Contains("aimp")) return "AIMP";
        if (appId.Contains("itunes")) return "iTunes";
        if (appId.Contains("amazonmusic")) return "Amazon Music";
        if (appId.Contains("deezer")) return "Deezer";
        if (appId.Contains("tidal")) return "TIDAL";
        if (appId.Contains("qobuz")) return "Qobuz";
        if (appId.Contains("plexamp") || appId.Contains("plex")) return "Plex";
        if (appId.Contains("musicbee")) return "MusicBee";
        if (appId.Contains("winamp")) return "Winamp";

        return "Music Player";
    }
}

/// <summary>
/// Application configuration stored in AppData
/// </summary>
class AppConfig
{
    public string DiscordAppId { get; set; } = "1455603540654297212";
    public string ApiBaseUrl { get; set; } = "https://api.livia.mom";
    public bool StartWithWindows { get; set; } = false;
    public bool ShowNotifications { get; set; } = true;
}
