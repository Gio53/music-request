import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import { CONFIG_DIR, DB_PATH } from "./config";

export type UserRow = {
  id: string;
  jellyfin_user_id: string;
  username: string;
  is_admin: number;
  api_token: string;
  created_at: string;
};

export type LibraryRow = {
  jellyfin_id: string;
  name: string;
  path: string | null;
  enabled: number;
};

export type LibraryItemRow = {
  jellyfin_id: string;
  library_id: string;
  type: "artist" | "album";
  name: string;
  artist_name: string | null;
  parent_id: string | null;
  musicbrainz_id: string | null;
  image_tag: string | null;
  path: string | null;
};

export type RequestStatus = "pending" | "processing" | "available" | "failed";

export type RequestRow = {
  id: string;
  type: "album" | "artist";
  user_id: string;
  artist: string;
  album: string | null;
  jellyfin_album_id: string | null;
  jellyfin_artist_id: string | null;
  musicbrainz_album_id: string | null;
  musicbrainz_artist_id: string | null;
  lidarr_album_id: number | null;
  lidarr_artist_id: number | null;
  status: RequestStatus;
  error: string | null;
  created_at: string;
  available_at: string | null;
  targets_json: string | null;
  requester: string;
};

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
  }
  return db;
}

function migrate(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      jellyfin_user_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      api_token TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS libraries (
      jellyfin_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT,
      enabled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS library_items (
      jellyfin_id TEXT PRIMARY KEY,
      library_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      artist_name TEXT,
      parent_id TEXT,
      musicbrainz_id TEXT,
      image_tag TEXT,
      path TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      jellyfin_album_id TEXT,
      jellyfin_artist_id TEXT,
      musicbrainz_album_id TEXT,
      musicbrainz_artist_id TEXT,
      lidarr_album_id INTEGER,
      lidarr_artist_id INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      available_at TEXT,
      targets_json TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_library_items_type ON library_items(type);
    CREATE INDEX IF NOT EXISTS idx_library_items_mb ON library_items(musicbrainz_id);
    CREATE INDEX IF NOT EXISTS idx_library_items_parent ON library_items(parent_id);
    CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
  `);

  if (!getSetting("cookie_secret")) {
    setSetting("cookie_secret", crypto.randomBytes(32).toString("hex"));
  }
  if (!getSetting("device_id")) {
    setSetting("device_id", crypto.randomUUID());
  }
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function deleteSetting(key: string) {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function isSetupComplete(): boolean {
  return getSetting("setup_complete") === "1";
}

export function upsertUser(input: {
  jellyfinUserId: string;
  username: string;
  isAdmin: boolean;
}): UserRow {
  const existing = getDb()
    .prepare("SELECT * FROM users WHERE jellyfin_user_id = ?")
    .get(input.jellyfinUserId) as UserRow | undefined;
  if (existing) {
    getDb()
      .prepare("UPDATE users SET username = ?, is_admin = ? WHERE id = ?")
      .run(input.username, input.isAdmin ? 1 : 0, existing.id);
    return getUserById(existing.id)!;
  }
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  const createdAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO users (id, jellyfin_user_id, username, is_admin, api_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.jellyfinUserId, input.username, input.isAdmin ? 1 : 0, token, createdAt);
  return getUserById(id)!;
}

export function getUserById(id: string): UserRow | null {
  return (getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
}

export function getUserByToken(token: string): UserRow | null {
  return (
    (getDb().prepare("SELECT * FROM users WHERE api_token = ?").get(token) as UserRow | undefined) ??
    null
  );
}

export function regenerateToken(userId: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  getDb().prepare("UPDATE users SET api_token = ? WHERE id = ?").run(token, userId);
  return token;
}

export function replaceLibraries(
  folders: Array<{ jellyfinId: string; name: string; path: string | null }>,
) {
  const database = getDb();
  const existing = new Map(
    (database.prepare("SELECT jellyfin_id, enabled FROM libraries").all() as LibraryRow[]).map(
      (row) => [row.jellyfin_id, row.enabled],
    ),
  );
  const tx = database.transaction(() => {
    const keep = new Set(folders.map((folder) => folder.jellyfinId));
    for (const folder of folders) {
      database
        .prepare(
          `INSERT INTO libraries (jellyfin_id, name, path, enabled)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(jellyfin_id) DO UPDATE SET name = excluded.name, path = excluded.path`,
        )
        .run(folder.jellyfinId, folder.name, folder.path, existing.get(folder.jellyfinId) ?? 0);
    }
    const stored = database.prepare("SELECT jellyfin_id FROM libraries").all() as Array<{
      jellyfin_id: string;
    }>;
    for (const row of stored) {
      if (!keep.has(row.jellyfin_id)) {
        database.prepare("DELETE FROM libraries WHERE jellyfin_id = ?").run(row.jellyfin_id);
      }
    }
  });
  tx();
}

export function listLibraries(): LibraryRow[] {
  return getDb().prepare("SELECT * FROM libraries ORDER BY name").all() as LibraryRow[];
}

export function setEnabledLibraries(ids: string[]) {
  const database = getDb();
  const enabled = new Set(ids);
  const tx = database.transaction(() => {
    const rows = database.prepare("SELECT jellyfin_id FROM libraries").all() as Array<{
      jellyfin_id: string;
    }>;
    for (const row of rows) {
      database
        .prepare("UPDATE libraries SET enabled = ? WHERE jellyfin_id = ?")
        .run(enabled.has(row.jellyfin_id) ? 1 : 0, row.jellyfin_id);
    }
  });
  tx();
}

export function enabledLibraryIds(): string[] {
  return (
    getDb().prepare("SELECT jellyfin_id FROM libraries WHERE enabled = 1").all() as Array<{
      jellyfin_id: string;
    }>
  ).map((row) => row.jellyfin_id);
}

export function replaceLibraryItems(libraryId: string, items: LibraryItemRow[]) {
  const database = getDb();
  const tx = database.transaction(() => {
    database.prepare("DELETE FROM library_items WHERE library_id = ?").run(libraryId);
    const insert = database.prepare(
      `INSERT INTO library_items
        (jellyfin_id, library_id, type, name, artist_name, parent_id, musicbrainz_id, image_tag, path)
       VALUES (@jellyfin_id, @library_id, @type, @name, @artist_name, @parent_id, @musicbrainz_id, @image_tag, @path)`,
    );
    for (const item of items) insert.run(item);
  });
  tx();
}

export function listArtists(): LibraryItemRow[] {
  return getDb()
    .prepare("SELECT * FROM library_items WHERE type = 'artist' ORDER BY name COLLATE NOCASE")
    .all() as LibraryItemRow[];
}

export function getLibraryItem(id: string): LibraryItemRow | null {
  return (
    (getDb().prepare("SELECT * FROM library_items WHERE jellyfin_id = ?").get(id) as
      | LibraryItemRow
      | undefined) ?? null
  );
}

export function listAlbumsForArtist(artistId: string): LibraryItemRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM library_items
       WHERE type = 'album' AND (parent_id = ? OR artist_name = (
         SELECT name FROM library_items WHERE jellyfin_id = ? AND type = 'artist'
       ))
       ORDER BY name COLLATE NOCASE`,
    )
    .all(artistId, artistId) as LibraryItemRow[];
}

export function findAlbumInLibrary(input: {
  jellyfinAlbumId?: string | null;
  musicbrainzAlbumId?: string | null;
}): LibraryItemRow | null {
  if (input.jellyfinAlbumId) {
    const byId = getDb()
      .prepare("SELECT * FROM library_items WHERE type = 'album' AND jellyfin_id = ?")
      .get(input.jellyfinAlbumId) as LibraryItemRow | undefined;
    if (byId) return byId;
  }
  if (input.musicbrainzAlbumId) {
    const byMb = getDb()
      .prepare("SELECT * FROM library_items WHERE type = 'album' AND musicbrainz_id = ?")
      .get(input.musicbrainzAlbumId) as LibraryItemRow | undefined;
    if (byMb) return byMb;
  }
  return null;
}

export function albumMbidsInLibrary(): Set<string> {
  const rows = getDb()
    .prepare(
      "SELECT musicbrainz_id FROM library_items WHERE type = 'album' AND musicbrainz_id IS NOT NULL",
    )
    .all() as Array<{ musicbrainz_id: string }>;
  return new Set(rows.map((row) => row.musicbrainz_id));
}

export function artistInLibrary(musicbrainzArtistId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM library_items WHERE type = 'artist' AND musicbrainz_id = ?")
    .get(musicbrainzArtistId);
  return Boolean(row);
}

export type RequestInput = {
  id: string;
  type: "album" | "artist";
  userId: string;
  artist: string;
  album: string | null;
  jellyfinAlbumId: string | null;
  jellyfinArtistId: string | null;
  musicbrainzAlbumId: string | null;
  musicbrainzArtistId: string | null;
  lidarrAlbumId: number | null;
  lidarrArtistId: number | null;
};

const REQUEST_SELECT = `
  SELECT requests.*, users.username AS requester
  FROM requests
  JOIN users ON users.id = requests.user_id
`;

export function insertRequest(input: RequestInput): RequestRow {
  const createdAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO requests (
        id, type, user_id, artist, album, jellyfin_album_id, jellyfin_artist_id,
        musicbrainz_album_id, musicbrainz_artist_id, lidarr_album_id, lidarr_artist_id,
        status, error, created_at, available_at, targets_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)`,
    )
    .run(
      input.id,
      input.type,
      input.userId,
      input.artist,
      input.album,
      input.jellyfinAlbumId,
      input.jellyfinArtistId,
      input.musicbrainzAlbumId,
      input.musicbrainzArtistId,
      input.lidarrAlbumId,
      input.lidarrArtistId,
      createdAt,
    );
  return getRequest(input.id)!;
}

export function getRequest(id: string): RequestRow | null {
  return (
    (getDb().prepare(`${REQUEST_SELECT} WHERE requests.id = ?`).get(id) as RequestRow | undefined) ??
    null
  );
}

export function listRequests(userId?: string): RequestRow[] {
  if (userId) {
    return getDb()
      .prepare(`${REQUEST_SELECT} WHERE requests.user_id = ? ORDER BY requests.created_at DESC`)
      .all(userId) as RequestRow[];
  }
  return getDb()
    .prepare(`${REQUEST_SELECT} ORDER BY requests.created_at DESC`)
    .all() as RequestRow[];
}

export function findOpenRequest(input: {
  userId: string;
  type: "album" | "artist";
  musicbrainzAlbumId?: string | null;
  musicbrainzArtistId?: string | null;
  jellyfinAlbumId?: string | null;
  jellyfinArtistId?: string | null;
}): RequestRow | null {
  const rows = listRequests(input.userId).filter((row) => row.type === input.type);
  return (
    rows.find((row) => {
      if (input.type === "album") {
        return (
          (input.musicbrainzAlbumId && row.musicbrainz_album_id === input.musicbrainzAlbumId) ||
          (input.jellyfinAlbumId && row.jellyfin_album_id === input.jellyfinAlbumId)
        );
      }
      return (
        (input.musicbrainzArtistId && row.musicbrainz_artist_id === input.musicbrainzArtistId) ||
        (input.jellyfinArtistId && row.jellyfin_artist_id === input.jellyfinArtistId)
      );
    }) ?? null
  );
}

export function updateRequest(
  id: string,
  patch: Partial<{
    status: RequestStatus;
    error: string | null;
    availableAt: string | null;
    lidarrAlbumId: number | null;
    lidarrArtistId: number | null;
    targetsJson: string | null;
    artist: string;
    album: string | null;
    musicbrainzAlbumId: string | null;
    musicbrainzArtistId: string | null;
  }>,
) {
  const current = getRequest(id);
  if (!current) return;
  getDb()
    .prepare(
      `UPDATE requests SET
        status = ?,
        error = ?,
        available_at = ?,
        lidarr_album_id = ?,
        lidarr_artist_id = ?,
        targets_json = ?,
        artist = ?,
        album = ?,
        musicbrainz_album_id = ?,
        musicbrainz_artist_id = ?
      WHERE id = ?`,
    )
    .run(
      patch.status ?? current.status,
      patch.error === undefined ? current.error : patch.error,
      patch.availableAt === undefined ? current.available_at : patch.availableAt,
      patch.lidarrAlbumId === undefined ? current.lidarr_album_id : patch.lidarrAlbumId,
      patch.lidarrArtistId === undefined ? current.lidarr_artist_id : patch.lidarrArtistId,
      patch.targetsJson === undefined ? current.targets_json : patch.targetsJson,
      patch.artist ?? current.artist,
      patch.album === undefined ? current.album : patch.album,
      patch.musicbrainzAlbumId === undefined ? current.musicbrainz_album_id : patch.musicbrainzAlbumId,
      patch.musicbrainzArtistId === undefined
        ? current.musicbrainz_artist_id
        : patch.musicbrainzArtistId,
      id,
    );
}

export function requestsByStatus(statuses: RequestStatus[]): RequestRow[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => "?").join(", ");
  return getDb()
    .prepare(`${REQUEST_SELECT} WHERE requests.status IN (${placeholders}) ORDER BY requests.created_at`)
    .all(...statuses) as RequestRow[];
}

export function configDirExists(): boolean {
  return fs.existsSync(path.dirname(DB_PATH));
}
