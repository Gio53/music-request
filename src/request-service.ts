import crypto from "crypto";
import {
  albumMbidsInLibrary,
  artistInLibrary,
  enabledLibraryIds,
  findAlbumInLibrary,
  findOpenRequest,
  getLibraryItem,
  getRequest,
  insertRequest,
  listRequests,
  requestsByStatus,
  updateRequest,
  type RequestRow,
} from "./db";
import { HttpError, ServiceError } from "./errors";
import { fetchItem, refreshJellyfinLibrary, syncLibrary } from "./jellyfin";
import {
  albumGrabFailed,
  albumHasFiles,
  albumImported,
  ensureArtist,
  historyForAlbum,
  monitorAlbums,
  searchAlbums,
  searchLidarr,
  tracksForAlbum,
  waitForAlbums,
  type LidarrAlbum,
} from "./lidarr";
import { recordingsForAlbum, recordingsForReleaseGroup, type TrackTitle } from "./musicbrainz";
import { downloadTrack } from "./youtube";

export type AlbumTarget = {
  musicbrainzAlbumId: string;
  title: string;
  lidarrAlbumId: number;
  saved?: boolean;
  youtube?: boolean;
  youtubeError?: string;
};

const running = new Set<string>();

export function toRequestJson(row: RequestRow) {
  return {
    id: row.id,
    type: row.type,
    artist: row.artist,
    album: row.album,
    status: row.status,
    requester: row.requester,
    createdAt: row.created_at,
    availableAt: row.available_at,
    error: row.error,
    jellyfinAlbumId: row.jellyfin_album_id,
    jellyfinArtistId: row.jellyfin_artist_id,
    musicbrainzAlbumId: row.musicbrainz_album_id,
    musicbrainzArtistId: row.musicbrainz_artist_id,
    lidarrAlbumId: row.lidarr_album_id,
    lidarrArtistId: row.lidarr_artist_id,
    targets: parseTargets(row.targets_json),
    progress: row.status === "available" ? 100 : row.progress || 0,
    progressLabel:
      row.progress_label ||
      (row.status === "available"
        ? "Done"
        : row.status === "failed"
          ? "Failed"
          : row.status === "pending"
            ? "Waiting"
            : "Working"),
  };
}

const lastProgressWrite = new Map<string, number>();

function reportProgress(id: string, progress: number, progressLabel: string) {
  const rounded = Math.max(0, Math.min(100, Math.round(progress)));
  const now = Date.now();
  const previous = lastProgressWrite.get(id) || 0;
  if (rounded < 100 && now - previous < 500) return;
  lastProgressWrite.set(id, now);
  updateRequest(id, { progress: rounded, progressLabel });
}

function parseTargets(raw: string | null): AlbumTarget[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AlbumTarget[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type CreateBody = {
  type?: "album" | "artist" | "song";
  jellyfinAlbumId?: string;
  jellyfinArtistId?: string;
  musicbrainzAlbumId?: string;
  musicbrainzArtistId?: string;
  lidarrAlbumId?: number;
  lidarrArtistId?: number;
  artist?: string;
  album?: string;
  song?: string;
};

export async function createRequest(userId: string, body: CreateBody): Promise<RequestRow> {
  const type = body.type;
  if (type !== "album" && type !== "artist" && type !== "song") {
    throw new HttpError(400, 'Request type must be "album", "artist", or "song".');
  }
  if (type === "song") return createSongRequest(userId, body);

  const resolved = await resolveIdentity(body);
  if (type === "album") {
    const existingItem = findAlbumInLibrary({
      jellyfinAlbumId: resolved.jellyfinAlbumId,
      musicbrainzAlbumId: resolved.musicbrainzAlbumId,
    });
    if (existingItem || resolved.albumExistsInJellyfin) {
      throw new HttpError(409, "Already in library");
    }
    if (!resolved.musicbrainzAlbumId || !resolved.musicbrainzArtistId) {
      throw new HttpError(
        400,
        "This album needs a MusicBrainz id before Lidarr can search for it.",
      );
    }
  } else if (!resolved.musicbrainzArtistId && !resolved.jellyfinArtistId) {
    throw new HttpError(400, "An artist request needs a Jellyfin or MusicBrainz artist id.");
  }

  const duplicate = findOpenRequest({
    userId,
    type,
    musicbrainzAlbumId: resolved.musicbrainzAlbumId,
    musicbrainzArtistId: resolved.musicbrainzArtistId,
    jellyfinAlbumId: resolved.jellyfinAlbumId,
    jellyfinArtistId: resolved.jellyfinArtistId,
  });
  if (duplicate) {
    if (duplicate.status === "failed") {
      updateRequest(duplicate.id, { status: "pending", error: null, progress: 0, progressLabel: "Waiting" });
      void processRequest(duplicate.id);
      return getRequest(duplicate.id)!;
    }
    return duplicate;
  }

  const row = insertRequest({
    id: crypto.randomUUID(),
    type,
    userId,
    artist: resolved.artist,
    album: type === "album" ? resolved.album : null,
    jellyfinAlbumId: resolved.jellyfinAlbumId,
    jellyfinArtistId: resolved.jellyfinArtistId,
    musicbrainzAlbumId: resolved.musicbrainzAlbumId,
    musicbrainzArtistId: resolved.musicbrainzArtistId,
    lidarrAlbumId: body.lidarrAlbumId && body.lidarrAlbumId > 0 ? body.lidarrAlbumId : null,
    lidarrArtistId: body.lidarrArtistId && body.lidarrArtistId > 0 ? body.lidarrArtistId : null,
  });
  void processRequest(row.id);
  return row;
}

async function createSongRequest(userId: string, body: CreateBody): Promise<RequestRow> {
  const artist = body.artist?.trim() || "";
  const song = (body.song || body.album)?.trim() || "";
  if (artist.length < 1 || song.length < 1) {
    throw new HttpError(400, "A song request needs an artist and a song title.");
  }
  if (artist.length > 200 || song.length > 200) {
    throw new HttpError(400, "The artist or song title is too long.");
  }
  const duplicate = findOpenRequest({ userId, type: "song", artist, album: song });
  if (duplicate) {
    if (duplicate.status === "failed") {
      updateRequest(duplicate.id, { status: "pending", error: null, progress: 0, progressLabel: "Waiting" });
      void processRequest(duplicate.id);
      return getRequest(duplicate.id)!;
    }
    return duplicate;
  }
  const row = insertRequest({
    id: crypto.randomUUID(),
    type: "song",
    userId,
    artist,
    album: song,
    jellyfinAlbumId: null,
    jellyfinArtistId: null,
    musicbrainzAlbumId: null,
    musicbrainzArtistId: null,
    lidarrAlbumId: null,
    lidarrArtistId: null,
  });
  void processRequest(row.id);
  return row;
}

async function resolveIdentity(body: CreateBody): Promise<{
  artist: string;
  album: string | null;
  jellyfinAlbumId: string | null;
  jellyfinArtistId: string | null;
  musicbrainzAlbumId: string | null;
  musicbrainzArtistId: string | null;
  albumExistsInJellyfin: boolean;
}> {
  let artist = body.artist?.trim() || "";
  let album = body.album?.trim() || null;
  let musicbrainzAlbumId = body.musicbrainzAlbumId?.trim() || null;
  let musicbrainzArtistId = body.musicbrainzArtistId?.trim() || null;
  const jellyfinAlbumId = body.jellyfinAlbumId?.trim() || null;
  const jellyfinArtistId = body.jellyfinArtistId?.trim() || null;
  let albumExistsInJellyfin = false;

  if (jellyfinAlbumId) {
    const cached = getLibraryItem(jellyfinAlbumId);
    if (cached) {
      albumExistsInJellyfin = cached.type === "album";
      artist = artist || cached.artist_name || "Unknown artist";
      album = album || cached.name;
      musicbrainzAlbumId = musicbrainzAlbumId || cached.musicbrainz_id;
    } else {
      const item = await fetchItem(jellyfinAlbumId);
      if (item?.Type === "MusicAlbum") albumExistsInJellyfin = true;
      if (item) {
        artist = artist || item.AlbumArtist || "Unknown artist";
        album = album || item.Name;
        musicbrainzAlbumId =
          musicbrainzAlbumId ||
          item.ProviderIds?.MusicBrainzReleaseGroup ||
          item.ProviderIds?.MusicBrainzAlbum ||
          null;
        musicbrainzArtistId =
          musicbrainzArtistId ||
          item.ProviderIds?.MusicBrainzAlbumArtist ||
          item.ProviderIds?.MusicBrainzArtist ||
          null;
      }
    }
  }

  if (jellyfinArtistId) {
    const cached = getLibraryItem(jellyfinArtistId);
    if (cached) {
      artist = artist || cached.name;
      musicbrainzArtistId = musicbrainzArtistId || cached.musicbrainz_id;
    } else {
      const item = await fetchItem(jellyfinArtistId);
      if (item) {
        artist = artist || item.Name;
        musicbrainzArtistId =
          musicbrainzArtistId ||
          item.ProviderIds?.MusicBrainzArtist ||
          item.ProviderIds?.MusicBrainzAlbumArtist ||
          null;
      }
    }
  }

  if (!artist) artist = "Unknown artist";
  if (body.type === "album" && !album) album = "Unknown album";
  return {
    artist,
    album,
    jellyfinAlbumId,
    jellyfinArtistId,
    musicbrainzAlbumId,
    musicbrainzArtistId,
    albumExistsInJellyfin,
  };
}

export async function processRequest(id: string) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const row = getRequest(id);
    if (!row || row.status === "available") return;
    updateRequest(id, { status: "processing", error: null, progress: 5, progressLabel: "Starting" });
    if (row.type === "song") await processSong(row);
    else if (row.type === "album") await processAlbumOrYoutube(row);
    else await processArtist(row);
  } catch (error) {
    const message =
      error instanceof ServiceError || error instanceof HttpError
        ? error.message
        : "The request could not be sent to Lidarr.";
    updateRequest(id, { status: "failed", error: message, progressLabel: "Failed" });
  } finally {
    running.delete(id);
  }
}

async function processSong(row: RequestRow) {
  if (!row.album) throw new HttpError(400, "A song request needs a title.");
  reportProgress(row.id, 8, "Searching YouTube");
  await downloadTrack({
    artist: row.artist,
    title: row.album,
    album: "Singles",
    onProgress: (percent) => reportProgress(row.id, 10 + percent * 0.85, `Downloading ${Math.round(percent)}%`),
  });
  updateRequest(row.id, {
    status: "available",
    availableAt: new Date().toISOString(),
    error: null,
    progress: 100,
    progressLabel: "Done",
  });
  void refreshAfterImport();
}

async function processAlbumOrYoutube(row: RequestRow) {
  try {
    await processAlbum(row);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) throw error;
    const lidarrMessage = error instanceof Error ? error.message : "Lidarr could not add this album.";
    try {
      const note = await saveAlbumFromYoutube({
        requestId: row.id,
        artist: row.artist,
        album: row.album || "",
        musicbrainzAlbumId: row.musicbrainz_album_id,
        lidarrAlbumId: row.lidarr_album_id,
      });
      updateRequest(row.id, {
        status: "available",
        availableAt: new Date().toISOString(),
        error: note,
        progress: 100,
        progressLabel: "Done",
      });
      void refreshAfterImport();
    } catch (youtubeError) {
      const youtubeMessage =
        youtubeError instanceof Error ? youtubeError.message : "YouTube fallback failed.";
      throw new ServiceError("youtube", `${lidarrMessage} YouTube fallback: ${youtubeMessage}`);
    }
  }
}

async function processAlbum(row: RequestRow) {
  if (!row.musicbrainz_artist_id || !row.musicbrainz_album_id) {
    throw new HttpError(400, "This album is missing MusicBrainz ids, so Lidarr cannot add it.");
  }
  reportProgress(row.id, 15, "Asking Lidarr");
  const artist = await ensureArtist(row.musicbrainz_artist_id, row.artist);
  const albums = await waitForAlbums(artist.id);
  const album = albums.find((item) => item.foreignAlbumId === row.musicbrainz_album_id);
  if (!album) {
    throw new ServiceError(
      "lidarr",
      `Lidarr did not return "${row.album}" for ${row.artist}. Try again in a minute.`,
    );
  }
  await monitorAlbums([album.id]);
  await searchAlbums([album.id]);
  updateRequest(row.id, {
    status: "processing",
    progress: 30,
    progressLabel: "Waiting for Lidarr",
    lidarrArtistId: artist.id,
    lidarrAlbumId: album.id,
    targetsJson: JSON.stringify([
      { musicbrainzAlbumId: album.foreignAlbumId, title: album.title, lidarrAlbumId: album.id },
    ] satisfies AlbumTarget[]),
    error: null,
  });
  await checkRequest(row.id);
}

async function processArtist(row: RequestRow) {
  if (!row.musicbrainz_artist_id) {
    throw new HttpError(
      400,
      "This artist has no MusicBrainz id in Jellyfin, so missing albums cannot be looked up.",
    );
  }
  reportProgress(row.id, 15, "Asking Lidarr");
  const artist = await ensureArtist(row.musicbrainz_artist_id, row.artist);
  const albums = await waitForAlbums(artist.id);
  const known = albumMbidsInLibrary();
  const missing = albums.filter((album) => album.foreignAlbumId && !known.has(album.foreignAlbumId));
  if (missing.length === 0) {
    throw new HttpError(409, "Already in library");
  }
  const ids = missing.map((album) => album.id).filter((albumId) => albumId > 0);
  await monitorAlbums(ids);
  await searchAlbums(ids);
  const targets: AlbumTarget[] = missing.map((album) => ({
    musicbrainzAlbumId: album.foreignAlbumId,
    title: album.title,
    lidarrAlbumId: album.id,
  }));
  updateRequest(row.id, {
    status: "processing",
    progress: 30,
    progressLabel: "Waiting for Lidarr",
    artist: artist.artistName || row.artist,
    lidarrArtistId: artist.id,
    targetsJson: JSON.stringify(targets),
    error: null,
  });
  await checkRequest(row.id);
}

export async function checkRequest(id: string): Promise<boolean> {
  const row = getRequest(id);
  if (!row || row.status === "available" || row.status === "failed" || row.status === "pending") {
    return false;
  }
  let targets = parseTargets(row.targets_json);
  if (targets.length === 0) return false;
  try {
    const withYoutube = await youtubeFailedTargets(row, targets);
    if (JSON.stringify(withYoutube) !== JSON.stringify(targets)) {
      targets = withYoutube;
      updateRequest(id, { targetsJson: JSON.stringify(targets) });
    }
    const ready = await Promise.all(targets.map((target) => targetIsAvailable(target)));
    if (ready.every(Boolean)) {
      const notes = targets.map((target) => target.youtubeError).filter(Boolean);
      updateRequest(id, {
        status: "available",
        availableAt: new Date().toISOString(),
        error: notes.length > 0 ? notes.join(" ") : null,
        progress: 100,
        progressLabel: "Done",
      });
      void refreshAfterImport();
      return true;
    }
    if (targets.every((target) => target.youtube || target.saved)) {
      const notes = targets.map((target) => target.youtubeError).filter(Boolean);
      if (ready.some(Boolean)) {
        updateRequest(id, {
          status: "available",
          availableAt: new Date().toISOString(),
          error: notes.join(" ") || null,
          progress: 100,
          progressLabel: "Done",
        });
        void refreshAfterImport();
        return true;
      }
      updateRequest(id, {
        status: "failed",
        error: notes.join(" ") || "Lidarr and YouTube could not get this music.",
        progressLabel: "Failed",
      });
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      console.error(`Status check skipped for ${id}: ${error.message}`);
      return false;
    }
    throw error;
  }
  return false;
}

async function youtubeFailedTargets(row: RequestRow, targets: AlbumTarget[]): Promise<AlbumTarget[]> {
  const next = targets.map((target) => ({ ...target }));
  for (const target of next) {
    if (target.saved || target.youtube || !target.lidarrAlbumId) continue;
    let failed = false;
    try {
      failed = albumGrabFailed(await historyForAlbum(target.lidarrAlbumId));
    } catch {
      continue;
    }
    if (!failed) continue;
    try {
      const note = await saveAlbumFromYoutube({
        requestId: row.id,
        artist: row.artist,
        album: target.title,
        musicbrainzAlbumId: target.musicbrainzAlbumId,
        lidarrAlbumId: target.lidarrAlbumId,
      });
      target.saved = true;
      target.youtube = true;
      if (note) target.youtubeError = note;
    } catch (error) {
      target.youtube = true;
      target.youtubeError = error instanceof Error ? error.message : "YouTube fallback failed.";
    }
  }
  return next;
}

async function trackList(input: {
  artist: string;
  album: string;
  musicbrainzAlbumId?: string | null;
  lidarrAlbumId?: number | null;
}): Promise<TrackTitle[]> {
  if (input.lidarrAlbumId && input.lidarrAlbumId > 0) {
    const tracks = await tracksForAlbum(input.lidarrAlbumId);
    if (tracks.length > 0) return tracks;
  }
  if (input.musicbrainzAlbumId) {
    try {
      const tracks = await recordingsForReleaseGroup(input.musicbrainzAlbumId);
      if (tracks.length > 0) return tracks;
    } catch {
      /* Search by name next. */
    }
  }
  if (!input.artist || !input.album) return [];
  return recordingsForAlbum(input.artist, input.album);
}

async function saveAlbumFromYoutube(input: {
  requestId?: string;
  artist: string;
  album: string;
  musicbrainzAlbumId?: string | null;
  lidarrAlbumId?: number | null;
}): Promise<string | null> {
  if (input.requestId) reportProgress(input.requestId, 40, "Looking up tracks");
  const tracks = (await trackList(input)).slice(0, 40);
  if (tracks.length === 0) {
    throw new ServiceError(
      "youtube",
      `No track list was found for "${input.album}" by ${input.artist}, so YouTube was not used.`,
    );
  }
  const failures: string[] = [];
  let saved = 0;
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    const span = 55 / tracks.length;
    const base = 40 + index * span;
    try {
      await downloadTrack({
        artist: input.artist,
        title: track.title,
        album: input.album,
        position: track.position,
        onProgress: (percent) => {
          if (!input.requestId) return;
          reportProgress(
            input.requestId,
            base + (percent / 100) * span,
            `Downloading ${track.title}`,
          );
        },
      });
      saved += 1;
    } catch (error) {
      failures.push(`${track.title}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  if (saved === 0) {
    throw new ServiceError("youtube", failures.slice(0, 2).join(" ") || "YouTube did not return those songs.");
  }
  if (failures.length === 0) return null;
  return `Saved ${saved} of ${tracks.length} songs from YouTube. ${failures.slice(0, 2).join(" ")}`;
}

async function targetIsAvailable(target: AlbumTarget): Promise<boolean> {
  if (target.saved) return true;
  if (target.lidarrAlbumId > 0 && (await albumHasFiles(target.lidarrAlbumId))) return true;
  if (target.lidarrAlbumId > 0) {
    const events = await historyForAlbum(target.lidarrAlbumId);
    if (albumImported(events)) return true;
  }
  return false;
}

let refreshing = false;
async function refreshAfterImport() {
  if (refreshing) return;
  refreshing = true;
  try {
    await refreshJellyfinLibrary();
    for (const libraryId of enabledLibraryIds()) {
      await syncLibrary(libraryId);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    refreshing = false;
  }
}

export async function pollRequests() {
  const pending = requestsByStatus(["pending"]);
  for (const row of pending) {
    await processRequest(row.id);
  }
  const processing = requestsByStatus(["processing"]);
  let imported = false;
  for (const row of processing) {
    if (await checkRequest(row.id)) imported = true;
  }
  if (imported) {
    /* refreshAfterImport already ran inside checkRequest */
  }
}

export async function buildSearch(term: string, userId: string) {
  const hits = await searchLidarr(term);
  const knownAlbums = albumMbidsInLibrary();
  const mine = listRequests(userId);
  const artists = [];
  const albums = [];
  for (const hit of hits) {
    if (hit.album) {
      const album = hit.album;
      const artist = album.artist;
      const musicbrainzAlbumId = album.foreignAlbumId;
      const musicbrainzArtistId = artist?.foreignArtistId || "";
      const match = mine.find(
        (row) => row.type === "album" && row.musicbrainz_album_id === musicbrainzAlbumId,
      );
      albums.push({
        title: album.title,
        artist: artist?.artistName || "Unknown artist",
        musicbrainzAlbumId,
        musicbrainzArtistId,
        lidarrAlbumId: album.id > 0 ? album.id : null,
        lidarrArtistId: artist && artist.id > 0 ? artist.id : null,
        year: album.releaseDate ? album.releaseDate.slice(0, 4) : null,
        cover: coverUrl(album),
        inLibrary: knownAlbums.has(musicbrainzAlbumId),
        requested: Boolean(match),
        requestStatus: match?.status || null,
      });
    } else if (hit.artist) {
      const artist = hit.artist;
      const match = mine.find(
        (row) => row.type === "artist" && row.musicbrainz_artist_id === artist.foreignArtistId,
      );
      artists.push({
        name: artist.artistName,
        musicbrainzArtistId: artist.foreignArtistId,
        lidarrArtistId: artist.id > 0 ? artist.id : null,
        overview: artist.overview || null,
        poster: artist.remotePoster || null,
        inLibrary: artistInLibrary(artist.foreignArtistId),
        requested: Boolean(match),
        requestStatus: match?.status || null,
      });
    }
  }
  return { artists, albums };
}

function coverUrl(album: LidarrAlbum): string | null {
  if (album.remoteCover) return album.remoteCover;
  const image = album.images?.find((item) => item.remoteUrl || item.url);
  return image?.remoteUrl || image?.url || null;
}

export async function retryRequest(id: string) {
  const row = getRequest(id);
  if (!row) throw new HttpError(404, "Request not found.");
  updateRequest(id, { status: "pending", error: null, progress: 0, progressLabel: "Waiting" });
  void processRequest(id);
  return getRequest(id)!;
}
