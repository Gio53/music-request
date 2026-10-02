import { FormEvent, useState } from "react";
import { api, ApiError, type SearchAlbum, type SearchArtist } from "../api";
import { Alert, Button, Card, TextField } from "../components/ui";

export function SearchPage() {
  const [term, setTerm] = useState("");
  const [artists, setArtists] = useState<SearchArtist[]>([]);
  const [albums, setAlbums] = useState<SearchAlbum[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await api<{ artists: SearchArtist[]; albums: SearchAlbum[] }>(
        `/api/search?term=${encodeURIComponent(term.trim())}`,
      );
      setArtists(data.artists);
      setAlbums(data.albums);
      setSearched(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  async function requestAlbum(album: SearchAlbum) {
    setError("");
    try {
      await api("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          type: "album",
          artist: album.artist,
          album: album.title,
          musicbrainzAlbumId: album.musicbrainzAlbumId,
          musicbrainzArtistId: album.musicbrainzArtistId,
        }),
      });
      setAlbums((current) =>
        current.map((item) =>
          item.musicbrainzAlbumId === album.musicbrainzAlbumId
            ? { ...item, requested: true, requestStatus: "pending" }
            : item,
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not request that album.");
    }
  }

  async function requestArtist(artist: SearchArtist) {
    setError("");
    try {
      await api("/api/requests", {
        method: "POST",
        body: JSON.stringify({
          type: "artist",
          artist: artist.name,
          musicbrainzArtistId: artist.musicbrainzArtistId,
        }),
      });
      setArtists((current) =>
        current.map((item) =>
          item.musicbrainzArtistId === artist.musicbrainzArtistId
            ? { ...item, requested: true, requestStatus: "pending" }
            : item,
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not request that artist.");
    }
  }

  return (
    <div>
      <h1 className="text-3xl font-bold">Search</h1>
      <p className="mt-2 text-muted">Find an artist or album through Lidarr and MusicBrainz, then request it.</p>
      <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={submit}>
        <div className="min-w-[16rem] flex-1">
          <TextField label="Artist or album" value={term} onChange={(event) => setTerm(event.target.value)} />
        </div>
        <Button disabled={busy || term.trim().length < 2} type="submit">
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {searched && artists.length === 0 && albums.length === 0 && (
        <p className="mt-8 text-muted">No artists or albums matched that search.</p>
      )}
      {artists.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">Artists</h2>
          <ul className="mt-4 space-y-3">
            {artists.map((artist) => (
              <li key={artist.musicbrainzArtistId}>
                <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <div>
                    <p className="font-semibold">{artist.name}</p>
                    {artist.inLibrary && <p className="text-sm text-muted">Some music is already in your library</p>}
                  </div>
                  <RequestAction
                    inLibrary={false}
                    requested={artist.requested}
                    status={artist.requestStatus}
                    label="Request all missing albums"
                    onRequest={() => requestArtist(artist)}
                  />
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
      {albums.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">Albums</h2>
          <ul className="mt-4 space-y-3">
            {albums.map((album) => (
              <li key={album.musicbrainzAlbumId}>
                <Card className="flex flex-wrap items-center gap-4 p-4">
                  {album.cover ? (
                    <img alt="" className="h-16 w-16 rounded-lg object-cover" src={album.cover} />
                  ) : (
                    <div className="h-16 w-16 rounded-lg bg-surface-2" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{album.title}</p>
                    <p className="text-sm text-muted">
                      {album.artist}
                      {album.year ? ` · ${album.year}` : ""}
                    </p>
                  </div>
                  <RequestAction
                    inLibrary={album.inLibrary}
                    requested={album.requested}
                    status={album.requestStatus}
                    label="Request"
                    onRequest={() => requestAlbum(album)}
                  />
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RequestAction({
  inLibrary,
  requested,
  status,
  label,
  onRequest,
}: {
  inLibrary: boolean;
  requested: boolean;
  status: string | null;
  label: string;
  onRequest: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  if (inLibrary) return <span className="text-sm font-semibold text-muted">Already in library</span>;
  if (requested) {
    return (
      <span className="text-sm font-semibold text-muted">
        {status === "available" ? "Available" : "Already requested"}
      </span>
    );
  }
  return (
    <Button
      disabled={busy}
      variant="accent"
      onClick={() => {
        setBusy(true);
        void onRequest().finally(() => setBusy(false));
      }}
    >
      {busy ? "Requesting…" : label}
    </Button>
  );
}
