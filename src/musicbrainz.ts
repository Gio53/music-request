import { ServiceError } from "./errors";

export type TrackTitle = { title: string; position: number };

const USER_AGENT = "MusicRequest/1.0 (https://github.com/Gio53/music-request)";
let nextRequestAt = 0;

async function musicbrainz(pathAndQuery: string): Promise<Record<string, unknown>> {
  const wait = nextRequestAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  nextRequestAt = Date.now() + 1100;
  let response: Response;
  try {
    response = await fetch(`https://musicbrainz.org/ws/2/${pathAndQuery}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ServiceError("youtube", "MusicBrainz is unreachable, so the track list could not be loaded.");
  }
  if (!response.ok) {
    throw new ServiceError("youtube", `MusicBrainz returned ${response.status} while looking up tracks.`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function tracksFromRelease(release: Record<string, unknown>): TrackTitle[] {
  const media = Array.isArray(release.media) ? release.media : [];
  const tracks: TrackTitle[] = [];
  for (const disc of media) {
    const discTracks = Array.isArray((disc as { tracks?: unknown }).tracks)
      ? ((disc as { tracks: Array<Record<string, unknown>> }).tracks)
      : [];
    for (const track of discTracks) {
      const recording = track.recording as { title?: string } | undefined;
      const title = String(track.title || recording?.title || "").trim();
      if (!title) continue;
      tracks.push({ title, position: tracks.length + 1 });
    }
  }
  return tracks;
}

export async function recordingsForReleaseGroup(releaseGroupId: string): Promise<TrackTitle[]> {
  const group = await musicbrainz(`release-group/${encodeURIComponent(releaseGroupId)}?inc=releases&fmt=json`);
  const releases = Array.isArray(group.releases) ? (group.releases as Array<{ id?: string; status?: string }>) : [];
  const chosen = releases.find((release) => release.status === "Official" && release.id) || releases.find((release) => release.id);
  if (!chosen?.id) return [];
  const release = await musicbrainz(`release/${encodeURIComponent(chosen.id)}?inc=recordings&fmt=json`);
  return tracksFromRelease(release);
}

export async function recordingsForAlbum(artist: string, album: string): Promise<TrackTitle[]> {
  const query = `release:"${album.replace(/"/g, "")}" AND artist:"${artist.replace(/"/g, "")}" AND status:official`;
  const page = await musicbrainz(`release?query=${encodeURIComponent(query)}&fmt=json&limit=1`);
  const releases = Array.isArray(page.releases) ? (page.releases as Array<{ id?: string }>) : [];
  const id = releases[0]?.id;
  if (!id) return [];
  const release = await musicbrainz(`release/${encodeURIComponent(id)}?inc=recordings&fmt=json`);
  return tracksFromRelease(release);
}
