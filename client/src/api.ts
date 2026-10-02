export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers || {}),
      },
    });
  } catch {
    throw new ApiError("Music Request could not reach the server.", 0);
  }
  const text = await response.text();
  const data = text ? (JSON.parse(text) as { error?: string }) : {};
  if (!response.ok) {
    throw new ApiError(data.error || `Request failed (${response.status}).`, response.status);
  }
  return data as T;
}

export type PublicUser = { id: string; username: string; isAdmin: boolean };

export type LibraryFolder = { id: string; name: string; path: string | null; enabled: boolean };

export type MusicRequest = {
  id: string;
  type: "album" | "artist" | "song";
  artist: string;
  album: string | null;
  status: "pending" | "processing" | "available" | "failed";
  requester: string;
  createdAt: string;
  availableAt?: string | null;
  error?: string | null;
  progress?: number;
  progressLabel?: string | null;
};

export type SearchArtist = {
  name: string;
  musicbrainzArtistId: string;
  overview?: string | null;
  poster?: string | null;
  inLibrary: boolean;
  requested: boolean;
  requestStatus: string | null;
};

export type SearchAlbum = {
  title: string;
  artist: string;
  musicbrainzAlbumId: string;
  musicbrainzArtistId: string;
  year?: string | null;
  cover?: string | null;
  inLibrary: boolean;
  requested: boolean;
  requestStatus: string | null;
};

export type LidarrOptions = {
  rootFolders: Array<{ id: number; path: string }>;
  qualityProfiles: Array<{ id: number; name: string }>;
  metadataProfiles: Array<{ id: number; name: string }>;
};

export type Settings = {
  jellyfinUrl: string;
  jellyfinUsername: string;
  jellyfinPasswordSet: boolean;
  lidarrUrl: string;
  lidarrApiKeyHint: string;
  lidarrRootFolder: string;
  lidarrQualityProfileId: number;
  lidarrMetadataProfileId: number;
  libraries: LibraryFolder[];
};
