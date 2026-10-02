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
  albumHasFiles,
  albumImported,
  ensureArtist,
  historyForAlbum,
  monitorAlbums,
  searchAlbums,
  searchLidarr,
  waitForAlbums,
  type LidarrAlbum,
} from "./lidarr";

export type AlbumTarget = {
  musicbrainzAlbumId: string;
  title: string;
  lidarrAlbumId: number;
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
  };
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
  type?: "album" | "artist";
  jellyfinAlbumId?: string;
  jellyfinArtistId?: string;
  musicbrainzAlbumId?: string;
  musicbrainzArtistId?: string;
  lidarrAlbumId?: number;
  lidarrArtistId?: number;
  artist?: string;
  album?: string;
};

export async function createRequest(userId: string, body: CreateBody): Promise<RequestRow> {
  const type = body.type;
  if (type !== "album" && type !== "artist") {
    throw new HttpError(400, 'Request type must be "album" or "artist".');
  }

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
      updateRequest(duplicate.id, { status: "pending", error: null });
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
    updateRequest(id, { status: "processing", error: null });
    if (row.type === "album") await processAlbum(row);
    else await processArtist(row);
  } catch (error) {
    const message =
      error instanceof ServiceError || error instanceof HttpError
        ? error.message
        : "The request could not be sent to Lidarr.";
    updateRequest(id, { status: "failed", error: message });
  } finally {
    running.delete(id);
  }
}

async function processAlbum(row: RequestRow) {
  if (!row.musicbrainz_artist_id || !row.musicbrainz_album_id) {
    throw new HttpError(400, "This album is missing MusicBrainz ids, so Lidarr cannot add it.");
  }
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
  const targets = parseTargets(row.targets_json);
  if (targets.length === 0) return false;
  try {
    const ready = await Promise.all(targets.map((target) => targetIsAvailable(target)));
    if (ready.every(Boolean)) {
      updateRequest(id, { status: "available", availableAt: new Date().toISOString(), error: null });
      void refreshAfterImport();
      return true;
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

async function targetIsAvailable(target: AlbumTarget): Promise<boolean> {
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
  updateRequest(id, { status: "pending", error: null });
  void processRequest(id);
  return getRequest(id)!;
}
