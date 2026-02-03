# LIVIA

**Enhanced Discord Music Activity Display**

Show what you're listening to on Discord — with real-time lyrics, album art, track progress, and listening history. LIVIA captures your currently playing music from any Windows media player and broadcasts it through Discord Rich Presence with a live web companion page.

> **Website:** [livia.mom](https://livia.mom)

---

## Features

- **Discord Rich Presence** — displays current track, artist, album art, and a live progress bar on your Discord profile
- **Universal media detection** — works with Spotify, Apple Music, YouTube Music, Tidal, and any app that uses Windows SMTC
- **Live companion page** — a shareable web page at `livia.mom/s/<session>` showing your real-time listening activity
- **Album art fetching** — pulls high-quality artwork via Last.fm
- **Listening history** — persistent server-side history of recently played tracks
- **AI-enriched metadata** — optional Gemini integration for genre, label, and artist info
- **System tray app** — lightweight Windows tray application that runs in the background
- **Cross-platform Electron app** — builds for Windows, macOS, and Linux

---

## Architecture

```
┌────────────────┐       ┌────────────────┐       ┌────────────────┐
│  livia-windows │──────▶│  livia-backend │◀──────│   livia-app    │
│   C# / .NET 8  │  HTTP │  Express.js    │  HTTP │   Electron     │
│                │       │                │       │                │
│ Reads SMTC and │       │ REST API that  │       │ Connects to    │
│ sends track    │       │ stores sessions│       │ Discord RPC,   │
│ data to the    │       │ and serves the │       │ fetches album  │
│ backend        │       │ companion page │       │ art, manages   │
│                │       │                │       │ rich presence   │
└────────────────┘       └────────────────┘       └────────────────┘
     Windows                  Server                  Desktop
     System Tray              (Docker)                (Electron)
```

| Component | Description | Tech |
|-----------|-------------|------|
| **livia-app** | Desktop client that manages Discord Rich Presence and media detection | Electron 28, discord-rpc, electron-store |
| **livia-backend** | API server for session management, listening history, and the companion page | Express.js 5, Docker |
| **livia-windows** | Windows system tray app that reads SMTC (System Media Transport Controls) | C#, .NET 8, Windows Forms, DiscordRichPresence |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) (for livia-windows)
- [Docker](https://www.docker.com/) (optional — for backend deployment)
- A [Discord Application](https://discord.com/developers/applications) with Rich Presence enabled

### Backend

```bash
cd livia-backend
npm install
node server.js
```

The server starts on port `4000` by default. Set the `PORT` environment variable to change it.

### Desktop App (Electron)

```bash
cd livia-app
npm install
```

Create a `.env` file in `livia-app/`:

```env
DISCORD_APP_ID=your_discord_app_id
API_BASE_URL=https://api.livia.mom
LASTFM_API_KEY=your_lastfm_api_key
GEMINI_API_KEY=your_gemini_api_key   # optional
```

Then run:

```bash
npm start
```

### Windows Companion (SMTC Reader)

```bash
cd livia-windows
dotnet build -c Release
```

Or use the build script at the project root:

```bash
./build.bat
```

The compiled `Livia.exe` is output to the `dist/` folder.

---

## Deployment

### Backend (Docker)

```bash
cd livia-backend
docker compose up -d
```

### Electron App (Distributables)

```bash
cd livia-app
npm run build:win      # Windows (.exe installer)
npm run build:mac      # macOS (.dmg)
npm run build:linux    # Linux (.AppImage)
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/session` | Create a new listening session |
| `PUT` | `/session/:id` | Update track / playback state |
| `GET` | `/session/:id` | Get session with real-time position |
| `DELETE` | `/session/:id` | End a session |
| `GET` | `/sessions/active` | List all active sessions |
| `GET` | `/sessions/user/:id` | Sessions for a specific Discord user |
| `GET` | `/history` | Recently played tracks |
| `GET` | `/history/user/:id` | History for a specific user |
| `DELETE` | `/history` | Clear history |
| `GET` | `/health` | Server health check |

---

## Project Structure

```
├── livia-app/             # Electron desktop client
│   ├── src/
│   │   ├── main.js        # App entry, Discord RPC, tray
│   │   ├── media-detector.js
│   │   └── album-art.js
│   └── assets/            # Icons
├── livia-backend/         # Express.js API server
│   ├── server.js
│   ├── Dockerfile
│   └── docker-compose.yml
├── livia-windows/         # C# SMTC reader (Windows)
│   ├── Program.cs
│   └── LiviaSMTCTest.csproj
├── home.html              # Landing page (livia.mom)
├── index.html             # Companion page (livia.mom/s/...)
├── build.bat              # Windows build script for livia-windows
└── Livia.sln              # Visual Studio solution
```

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
