import { getSetting } from "./db";
import { ServiceError } from "./errors";
import { normalizeUrl } from "./jellyfin";

export type LidarrImage = { coverType?: string; url?: string; remoteUrl?: string };

export type LidarrArtist = {
  id: number;
  artistName: string;
  foreignArtistId: string;
  overview?: string;
  remotePoster?: string;
  images?: LidarrImage[];
  monitored?: boolean;
};

export type LidarrAlbum = {
  id: number;
  title: string;
  foreignAlbumId: string;
  artistId?: number;
  releaseDate?: string;
  remoteCover?: string;
  monitored?: boolean;
  artist?: LidarrArtist;
  statistics?: { trackFileCount?: number; totalTrackCount?: number };
  images?: LidarrImage[];
};

export type LidarrSearchHit = {
  id: number;
  foreignId?: string;
  artist?: LidarrArtist;
  album?: LidarrAlbum;
};

export type NamedId = { id: number; name: string };
export type RootFolder = { id: number; path: string; freeSpace?: number };

function trimUrl(url: string): string {
  return normalizeUrl(url);
}

async function lidarrFetch(
  baseUrl: string,
  apiKey: string,
  pathAndQuery: string,
  init: RequestInit = {},
): Promise<Response> {
  const root = trimUrl(baseUrl);
  let response: Response;
  try {
    response = await fetch(`${root}${pathAndQuery}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ServiceError("lidarr", `Lidarr is unreachable at ${root}`);
  }
  return response;
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = await response.text();
    if (!body) return "";
    const parsed = JSON.parse(body) as Array<{ errorMessage?: string }> | { message?: string; title?: string };
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => entry.errorMessage).filter(Boolean).join(" ");
    }
    return parsed.message || parsed.title || "";
  } catch {
    return "";
  }
}

async function lidarrJson<T>(baseUrl: string, apiKey: string, pathAndQuery: string, init?: RequestInit): Promise<T> {
  const response = await lidarrFetch(baseUrl, apiKey, pathAndQuery, init);
  if (!response.ok) {
    const detail = await parseError(response);
    throw new ServiceError(
      "lidarr",
      detail
        ? `Lidarr returned ${response.status}: ${detail}`
        : `Lidarr returned ${response.status} for ${pathAndQuery.split("?")[0]}.`,
    );
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function configured(): { url: string; apiKey: string } {
  const url = getSetting("lidarr_url");
  const apiKey = getSetting("lidarr_api_key");
  if (!url || !apiKey) {
    throw new ServiceError("lidarr", "Lidarr is not configured. Add the URL and API key in Settings.");
  }
  return { url, apiKey };
}

export async function testLidarr(url: string, apiKey: string): Promise<{ version: string; appName: string }> {
  const status = await lidarrJson<{ version?: string; appName?: string }>(
    url,
    apiKey,
    "/api/v1/system/status",
  );
  return { version: status.version || "unknown", appName: status.appName || "Lidarr" };
}

export async function lidarrOptions(url: string, apiKey: string): Promise<{
  rootFolders: RootFolder[];
  qualityProfiles: NamedId[];
  metadataProfiles: NamedId[];
}> {
  const [rootFolders, qualityProfiles, metadataProfiles] = await Promise.all([
    lidarrJson<RootFolder[]>(url, apiKey, "/api/v1/rootfolder"),
    lidarrJson<NamedId[]>(url, apiKey, "/api/v1/qualityprofile"),
    lidarrJson<NamedId[]>(url, apiKey, "/api/v1/metadataprofile").catch((error: unknown) => {
      if (error instanceof ServiceError && error.message.includes("404")) return [];
      throw error;
    }),
  ]);
  return { rootFolders, qualityProfiles, metadataProfiles };
}

export async function searchLidarr(term: string): Promise<LidarrSearchHit[]> {
  const { url, apiKey } = configured();
  return lidarrJson<LidarrSearchHit[]>(url, apiKey, `/api/v1/search?term=${encodeURIComponent(term)}`);
}

export async function listArtists(): Promise<LidarrArtist[]> {
  const { url, apiKey } = configured();
  return lidarrJson<LidarrArtist[]>(url, apiKey, "/api/v1/artist");
}

function artistLibraryPath(rootFolderPath: string, artistName: string): string {
  const folder = artistName
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!folder) {
    throw new ServiceError("lidarr", "This artist needs a name before Lidarr can add them.");
  }
  const root = rootFolderPath.replace(/[\\/]+$/, "");
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${separator}${folder}`;
}

export async function addArtist(input: {
  foreignArtistId: string;
  artistName?: string;
}): Promise<LidarrArtist> {
  const { url, apiKey } = configured();
  const qualityProfileId = Number(getSetting("lidarr_quality_profile_id"));
  const metadataProfileId = Number(getSetting("lidarr_metadata_profile_id") || 0);
  const rootFolderPath = getSetting("lidarr_root_folder");
  if (!qualityProfileId || !rootFolderPath) {
    throw new ServiceError(
      "lidarr",
      "Choose a Lidarr root folder and quality profile in Settings before requesting music.",
    );
  }
  const artistName = input.artistName?.trim() || "";
  if (!artistName) {
    throw new ServiceError("lidarr", "This artist needs a name before Lidarr can add them.");
  }
  // Lidarr builds the folder from Artist Folder Format. A blank format makes the
  // path the root folder itself, which Lidarr then rejects.
  const body: Record<string, unknown> = {
    foreignArtistId: input.foreignArtistId,
    artistName,
    qualityProfileId,
    rootFolderPath,
    path: artistLibraryPath(rootFolderPath, artistName),
    monitored: true,
    addOptions: {
      monitor: "none",
      searchForMissingAlbums: false,
    },
  };
  if (metadataProfileId) body.metadataProfileId = metadataProfileId;
  try {
    return await lidarrJson<LidarrArtist>(url, apiKey, "/api/v1/artist", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/already been added/i.test(message)) {
      const existing = (await listArtists()).find(
        (artist) => artist.foreignArtistId === input.foreignArtistId,
      );
      if (existing) return existing;
    }
    throw error;
  }
}

export async function ensureArtist(foreignArtistId: string, artistName?: string): Promise<LidarrArtist> {
  const existing = (await listArtists()).find((artist) => artist.foreignArtistId === foreignArtistId);
  if (existing) return existing;
  return addArtist({ foreignArtistId, artistName });
}

export async function albumsForArtist(artistId: number): Promise<LidarrAlbum[]> {
  const { url, apiKey } = configured();
  return lidarrJson<LidarrAlbum[]>(url, apiKey, `/api/v1/album?artistId=${artistId}`);
}

export async function refreshArtist(artistId: number) {
  const { url, apiKey } = configured();
  await lidarrJson(url, apiKey, "/api/v1/command", {
    method: "POST",
    body: JSON.stringify({ name: "RefreshArtist", artistId }),
  });
}

export async function waitForAlbums(artistId: number): Promise<LidarrAlbum[]> {
  let albums = await albumsForArtist(artistId);
  if (albums.length > 0) return albums;
  await refreshArtist(artistId);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    albums = await albumsForArtist(artistId);
    if (albums.length > 0) return albums;
  }
  return albums;
}

export async function monitorAlbums(albumIds: number[]) {
  if (albumIds.length === 0) return;
  const { url, apiKey } = configured();
  await lidarrJson(url, apiKey, "/api/v1/album/monitor", {
    method: "PUT",
    body: JSON.stringify({ albumIds, monitored: true }),
  });
}

export async function searchAlbums(albumIds: number[]) {
  const { url, apiKey } = configured();
  for (let index = 0; index < albumIds.length; index += 25) {
    const chunk = albumIds.slice(index, index + 25);
    await lidarrJson(url, apiKey, "/api/v1/command", {
      method: "POST",
      body: JSON.stringify({ name: "AlbumSearch", albumIds: chunk }),
    });
  }
}

export async function getAlbum(albumId: number): Promise<LidarrAlbum | null> {
  const { url, apiKey } = configured();
  const albums = await lidarrJson<LidarrAlbum[]>(url, apiKey, `/api/v1/album?albumIds=${albumId}`);
  return albums[0] || null;
}

export type LidarrHistoryEvent = {
  eventType?: string;
  albumId?: number;
  date?: string;
};

export async function historyForAlbum(albumId: number): Promise<LidarrHistoryEvent[]> {
  const { url, apiKey } = configured();
  const page = await lidarrJson<{ records?: LidarrHistoryEvent[] } | LidarrHistoryEvent[]>(
    url,
    apiKey,
    `/api/v1/history?page=1&pageSize=50&albumId=${albumId}&sortKey=date&sortDirection=descending`,
  );
  if (Array.isArray(page)) return page;
  return page.records || [];
}

export function albumImported(events: LidarrHistoryEvent[]): boolean {
  return events.some((event) => {
    const type = (event.eventType || "").toLowerCase();
    return type.includes("import") && !type.includes("fail");
  });
}

export async function albumHasFiles(albumId: number): Promise<boolean> {
  const album = await getAlbum(albumId);
  return (album?.statistics?.trackFileCount || 0) > 0;
}
