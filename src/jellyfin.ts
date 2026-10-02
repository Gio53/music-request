import { CLIENT_NAME, CLIENT_VERSION } from "./config";
import { getSetting, setSetting, replaceLibraries, replaceLibraryItems, type LibraryItemRow } from "./db";
import { ServiceError } from "./errors";

export type JellyfinUser = {
  Id: string;
  Name: string;
  Policy?: { IsAdministrator?: boolean };
};

export type JellyfinAuth = {
  AccessToken: string;
  User: JellyfinUser;
};

export type JellyfinFolder = {
  Id: string;
  Name: string;
  Path?: string;
  Type?: string;
  CollectionType?: string;
};

type JellyfinItem = {
  Id: string;
  Name: string;
  Type: string;
  Path?: string;
  ParentId?: string;
  AlbumArtist?: string;
  AlbumArtists?: Array<{ Name?: string }>;
  ImageTags?: { Primary?: string };
  ProviderIds?: Record<string, string>;
};

export function mediaBrowserHeader(deviceId: string, token?: string): string {
  const parts = [
    `Client="${CLIENT_NAME}"`,
    `Device="${CLIENT_NAME}"`,
    `DeviceId="${deviceId}"`,
    `Version="${CLIENT_VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(", ")}`;
}

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function isMusicLibrary(folder: { Type?: string; CollectionType?: string }): boolean {
  return folder.Type === "CollectionFolder" && folder.CollectionType === "music";
}

function deviceId(): string {
  const id = getSetting("device_id");
  if (!id) throw new ServiceError("jellyfin", "Music Request is not configured yet.");
  return id;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.text();
    if (!body) return "";
    const parsed = JSON.parse(body) as { Message?: string; message?: string };
    return parsed.Message || parsed.message || "";
  } catch {
    return "";
  }
}

export async function authenticate(
  baseUrl: string,
  username: string,
  password: string,
  id = deviceId(),
): Promise<JellyfinAuth> {
  const root = normalizeUrl(baseUrl);
  let response: Response;
  try {
    response = await fetch(`${root}/Users/AuthenticateByName`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: mediaBrowserHeader(id),
      },
      body: JSON.stringify({ Username: username, Pw: password }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ServiceError("jellyfin", `Jellyfin is unreachable at ${root}`);
  }
  if (!response.ok) {
    throw new ServiceError(
      "jellyfin",
      `Jellyfin rejected the login (${response.status}). Check the URL, username, and password.`,
      response.status === 401 ? 401 : 502,
    );
  }
  return (await response.json()) as JellyfinAuth;
}

async function authorizedFetch(pathAndQuery: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const root = getSetting("jellyfin_url");
  const token = getSetting("jellyfin_access_token");
  if (!root || !token) {
    throw new ServiceError("jellyfin", "Jellyfin is not configured. Finish setup in Settings.");
  }
  let response: Response;
  try {
    response = await fetch(`${normalizeUrl(root)}${pathAndQuery}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: mediaBrowserHeader(deviceId(), token),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new ServiceError("jellyfin", `Jellyfin is unreachable at ${root}`);
  }
  if (response.status === 401 && retry) {
    await reauthenticate();
    return authorizedFetch(pathAndQuery, init, false);
  }
  return response;
}

export async function reauthenticate() {
  const url = getSetting("jellyfin_url");
  const username = getSetting("jellyfin_username");
  const password = getSetting("jellyfin_password");
  if (!url || !username || !password) {
    throw new ServiceError("jellyfin", "Saved Jellyfin credentials are missing. Update them in Settings.");
  }
  const auth = await authenticate(url, username, password);
  setSetting("jellyfin_access_token", auth.AccessToken);
  setSetting("jellyfin_admin_id", auth.User.Id);
  setSetting("jellyfin_admin_name", auth.User.Name);
}

export async function fetchMusicFolders(baseUrl?: string, token?: string): Promise<JellyfinFolder[]> {
  const root = normalizeUrl(baseUrl || getSetting("jellyfin_url") || "");
  const access = token || getSetting("jellyfin_access_token") || "";
  if (!root || !access) {
    throw new ServiceError("jellyfin", "Jellyfin is not configured.");
  }
  let response: Response;
  try {
    response = await fetch(`${root}/Library/MediaFolders`, {
      headers: {
        Accept: "application/json",
        Authorization: mediaBrowserHeader(deviceId(), access),
      },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ServiceError("jellyfin", `Jellyfin is unreachable at ${root}`);
  }
  if (!response.ok) {
    const detail = await readError(response);
    throw new ServiceError(
      "jellyfin",
      detail
        ? `Jellyfin could not list libraries (${response.status}): ${detail}`
        : `Jellyfin could not list libraries (${response.status}).`,
    );
  }
  const body = (await response.json()) as { Items?: JellyfinFolder[] };
  return (body.Items || []).filter(isMusicLibrary);
}

export async function saveDiscoveredLibraries() {
  const folders = await fetchMusicFolders();
  replaceLibraries(
    folders.map((folder) => ({
      jellyfinId: folder.Id,
      name: folder.Name,
      path: folder.Path || null,
    })),
  );
  return folders;
}

function musicBrainzId(item: JellyfinItem): string | null {
  const ids = item.ProviderIds || {};
  if (item.Type === "MusicAlbum") {
    return ids.MusicBrainzReleaseGroup || ids.MusicBrainzAlbum || null;
  }
  return ids.MusicBrainzArtist || ids.MusicBrainzAlbumArtist || null;
}

export async function syncLibrary(libraryId: string) {
  const items: LibraryItemRow[] = [];
  let start = 0;
  const limit = 200;
  for (;;) {
    const params = new URLSearchParams({
      ParentId: libraryId,
      Recursive: "true",
      IncludeItemTypes: "MusicAlbum,MusicArtist",
      Fields: "Path,ProviderIds,ImageTags",
      StartIndex: String(start),
      Limit: String(limit),
    });
    const response = await authorizedFetch(`/Items?${params.toString()}`);
    if (!response.ok) {
      const detail = await readError(response);
      throw new ServiceError(
        "jellyfin",
        detail
          ? `Jellyfin library sync failed (${response.status}): ${detail}`
          : `Jellyfin library sync failed (${response.status}).`,
      );
    }
    const body = (await response.json()) as { Items?: JellyfinItem[] };
    const batch = body.Items || [];
    for (const item of batch) {
      if (item.Type !== "MusicAlbum" && item.Type !== "MusicArtist") continue;
      const artistName =
        item.AlbumArtist || item.AlbumArtists?.find((artist) => artist.Name)?.Name || null;
      items.push({
        jellyfin_id: item.Id,
        library_id: libraryId,
        type: item.Type === "MusicAlbum" ? "album" : "artist",
        name: item.Name,
        artist_name: artistName,
        parent_id: item.ParentId || null,
        musicbrainz_id: musicBrainzId(item),
        image_tag: item.ImageTags?.Primary || null,
        path: item.Path || null,
      });
    }
    if (batch.length < limit) break;
    start += limit;
  }
  replaceLibraryItems(libraryId, items);
  return items.length;
}

export async function refreshJellyfinLibrary() {
  const response = await authorizedFetch("/Library/Refresh", { method: "POST" });
  if (!response.ok && response.status !== 204) {
    const detail = await readError(response);
    throw new ServiceError(
      "jellyfin",
      detail
        ? `Jellyfin library refresh failed (${response.status}): ${detail}`
        : `Jellyfin library refresh failed (${response.status}).`,
    );
  }
}

export async function fetchPrimaryImage(itemId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!/^[A-Za-z0-9-]+$/.test(itemId)) return null;
  const root = getSetting("jellyfin_url");
  const token = getSetting("jellyfin_access_token");
  if (!root || !token) return null;
  let response: Response;
  try {
    response = await fetch(
      `${normalizeUrl(root)}/Items/${itemId}/Images/Primary?maxWidth=400&quality=90`,
      {
        headers: { Authorization: mediaBrowserHeader(deviceId(), token) },
        signal: AbortSignal.timeout(20000),
      },
    );
  } catch {
    throw new ServiceError("jellyfin", `Jellyfin is unreachable at ${root}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ServiceError("jellyfin", `Jellyfin could not load cover art (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    contentType: response.headers.get("content-type") || "image/jpeg",
  };
}

export async function fetchItem(itemId: string): Promise<JellyfinItem | null> {
  if (!/^[A-Za-z0-9-]+$/.test(itemId)) return null;
  const response = await authorizedFetch(
    `/Items?Ids=${encodeURIComponent(itemId)}&Fields=ProviderIds,Path,ImageTags`,
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { Items?: JellyfinItem[] };
  return body.Items?.[0] || null;
}
