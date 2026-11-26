# Spotify Account Sync

Sync public Spotify profile playlists (and individual public Spotify playlist URLs) directly into Nuclear — **no Spotify login, OAuth, or API keys required**.

## Features

- **Profile Sync:** Paste any public Spotify profile URL (`https://open.spotify.com/user/...`), `spotify:user:...` URI, or username to discover and sync up to 25 public playlists.
- **Single Playlist Sync:** Paste a direct Spotify playlist URL (`https://open.spotify.com/playlist/...`) or URI (`spotify:playlist:...`) to import and keep that playlist synced.
- **In-Place Updates:** Re-syncing updates existing synced Nuclear playlists in place so your folder placement and playlist IDs stay intact.
- **Auto-Sync on Launch:** Optionally refreshes synced playlists automatically when Nuclear starts.
- **Dedicated Sidebar View & Settings Widget:** Manage your target profile/playlist, view live progress, and jump straight to synced playlists.

## Usage

1. Install and enable **Spotify Account Sync** from the Nuclear Plugin Store.
2. Open **Spotify Sync** in the sidebar (or configure it under **Settings → Plugins → Spotify Account Sync**).
3. Enter your public Spotify profile link, username, or playlist link, then click **Sync Public Playlists Now**.

## Permissions & Privacy

- `network`: Uses Nuclear's `api.Http.fetch` exclusively to read public pages on `https://open.spotify.com`. No credentials or third-party trackers are used.
