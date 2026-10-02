import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { Alert, Button } from "../components/ui";

type Artist = { id: string; name: string; musicbrainzId: string | null; hasImage: boolean };
type Album = { id: string; name: string; artist: string | null; hasImage: boolean };

export function Library() {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ artists: Artist[] }>("/api/library/artists")
      .then((data) => setArtists(data.artists))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not load the library."));
  }, []);

  return (
    <div>
      <h1 className="text-3xl font-bold">Library</h1>
      <p className="mt-2 text-muted">Artists already in the synced Jellyfin music libraries.</p>
      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {artists.length === 0 && !error && <p className="mt-8 text-muted">No artists synced yet.</p>}
      <ul className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {artists.map((artist) => (
          <li key={artist.id}>
            <Link
              className="block rounded-xl border border-line bg-surface p-3 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              to={`/library/${artist.id}`}
            >
              <Cover id={artist.id} label={artist.name} enabled={artist.hasImage} />
              <span className="mt-3 block font-semibold">{artist.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ArtistPage() {
  const { artistId = "" } = useParams();
  const [artist, setArtist] = useState<{ id: string; name: string; musicbrainzId: string | null } | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ artist: { id: string; name: string; musicbrainzId: string | null }; albums: Album[] }>(
      `/api/library/artists/${artistId}/albums`,
    )
      .then((data) => {
        setArtist(data.artist);
        setAlbums(data.albums);
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not load albums."));
  }, [artistId]);

  async function requestMissing() {
    if (!artist) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          type: "artist",
          jellyfinArtistId: artist.id,
          musicbrainzArtistId: artist.musicbrainzId,
          artist: artist.name,
        }),
      });
      setMessage("Request sent. Lidarr will search for albums that are not already in Jellyfin.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Link className="text-sm font-semibold text-primary" to="/library">
        Back to artists
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">{artist?.name || "Artist"}</h1>
        <Button disabled={busy || !artist} variant="accent" onClick={() => void requestMissing()}>
          {busy ? "Requesting…" : "Request missing albums"}
        </Button>
      </div>
      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {message && <p className="mt-4 text-sm">{message}</p>}
      <ul className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {albums.map((album) => (
          <li key={album.id} className="rounded-xl border border-line bg-surface p-3">
            <Cover id={album.id} label={album.name} enabled={album.hasImage} />
            <span className="mt-3 block font-semibold">{album.name}</span>
            <p className="mt-3 text-sm font-semibold text-muted">Already in library</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Cover({ id, label, enabled }: { id: string; label: string; enabled: boolean }) {
  if (!enabled) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-lg bg-surface-2 text-sm text-muted">
        {label.slice(0, 1)}
      </div>
    );
  }
  return <img alt="" className="aspect-square w-full rounded-lg object-cover" src={`/api/images/${id}`} />;
}
