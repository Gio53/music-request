# Music Request

Self-hosted music requests for Jellyfin. People sign in with a Jellyfin account, browse the music library, or search MusicBrainz through Lidarr, and ask Lidarr to download an album. When Lidarr imports it, Music Request asks Jellyfin to scan. The app never deletes, moves, or renames files in your music folders.

## What you need

- Docker
- Jellyfin 12.x with at least one music library
- A Jellyfin administrator account (used by the server to sync libraries)
- Lidarr, with a root folder, quality profile, and API key

## Run

```bash
docker compose up -d --build
```

Open `http://localhost:5656`.

The first visit is a setup wizard:

1. Jellyfin URL, admin username, and password. Music Request checks the connection and lists music libraries (`CollectionType` of `music` only).
2. Choose which libraries to sync.
3. Lidarr URL and API key. Test the connection, then pick the root folder, quality profile, and metadata profile.
4. Sync and finish. You are signed in as that Jellyfin admin.

Settings, including the Jellyfin password and Lidarr API key, are stored in the SQLite file on the `./config` volume (`/app/config/music-request.db` in the container). Treat that folder as private.

The server listens on port **5656**. `GET /api/health` returns `{ "ok": true }`.

## Sign in

After setup, everyone signs in with their Jellyfin username and password. Jellyfin administrators are administrators here. Admins see every request and the Settings page. Other people only see their own requests.

Jellyfin 12.1 rejects the old `X-Emby-Token` header. Music Request sends:

`Authorization: MediaBrowser Client="MusicRequest", Device="MusicRequest", DeviceId="<id>", Version="1.0", Token="<token>"`

## Request something

- **Library** shows artists and albums already in the synced Jellyfin libraries. Albums there say “Already in library”. An artist page can request the albums Lidarr knows about that are still missing.
- **Search** looks up artists and albums through Lidarr (MusicBrainz). Request an album, or request every missing album by an artist.
- A single song is not a request. Lidarr adds whole albums. Searching a song title can still find the album.

Requests move from pending to processing while Lidarr searches, then to available after Lidarr’s history shows the album was imported. That also triggers a Jellyfin library scan. Admins can retry a failed request from All Requests.

If Jellyfin or Lidarr cannot be reached, the page shows that directly (for example, `Jellyfin is unreachable at http://...`).

## Feishin

The desktop app cannot use a browser userscript, and Feishin has no plugin API, so request buttons live in a fork of `jeffvli/feishin` (`development`) in the `feishin/` folder. It stays GPL-3.0.

In Feishin settings, under Music Request, set:

- URL, such as `http://192.168.1.20:5656` (use the machine address, not `localhost`, if Feishin runs on another computer)
- API token, copied from **My Requests** in this web app

Then use the **Request** item in the Feishin sidebar to search for an artist or album and request it. **My Requests** lists status. An artist you already have has **Request all missing albums**. An album you already have shows **Already in library**.

Build the Windows app from `feishin/`:

```bash
pnpm install
pnpm run package:win:pr
```

The installer is written under `feishin/dist` or `feishin/release`, depending on electron-builder.

## Develop without Docker

```bash
npm install
npm install --prefix client
npm run dev
```

The API is on port 5656 and the Vite UI is on port 5173.
