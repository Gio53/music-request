import { useEffect, useState } from "react";
import { api, ApiError, type MusicRequest } from "../api";
import { Alert, Button, Card, StatusBadge } from "../components/ui";

export function RequestsPage({ scope }: { scope: "mine" | "all" }) {
  const [requests, setRequests] = useState<MusicRequest[]>([]);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const path = scope === "mine" ? "/api/requests?mine=true" : "/api/requests";
      setRequests(await api<MusicRequest[]>(path));
      if (scope === "mine") {
        const body = await api<{ token: string }>("/api/me/token");
        setToken(body.token);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load requests.");
    }
  }

  useEffect(() => {
    void load();
  }, [scope]);

  async function retry(id: string) {
    setError("");
    try {
      await api(`/api/requests/${id}/retry`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Retry failed.");
    }
  }

  async function regenerate() {
    const body = await api<{ token: string }>("/api/me/token", { method: "POST" });
    setToken(body.token);
  }

  return (
    <div>
      <h1 className="text-3xl font-bold">{scope === "all" ? "All requests" : "My requests"}</h1>
      <p className="mt-2 text-muted">
        Pending requests are sent to Lidarr. Available means Lidarr imported the album and Jellyfin was asked to scan.
      </p>
      {scope === "mine" && token && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">Feishin API token</h2>
          <p className="mt-2 text-sm text-muted">
            Paste the Music Request URL and this token into Feishin settings. Treat the token like a password.
          </p>
          <code className="mt-4 block overflow-x-auto rounded-lg bg-surface-2 p-4 text-sm">{token}</code>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(token).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy token"}
            </Button>
            <Button variant="ghost" onClick={() => void regenerate()}>
              Regenerate
            </Button>
          </div>
        </Card>
      )}
      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {requests.length === 0 && <p className="mt-8 text-muted">No requests yet.</p>}
      <ul className="mt-6 space-y-3">
        {requests.map((request) => (
          <li key={request.id}>
            <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
              <div>
                <p className="font-semibold">
                  {request.type === "album" ? request.album : request.artist}
                </p>
                <p className="text-sm text-muted">
                  {request.type === "album" ? request.artist : "All missing albums"}
                  {scope === "all" ? ` · ${request.requester}` : ""}
                </p>
                {request.error && (
                  <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>
                    {request.error}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={request.status} />
                {scope === "all" && request.status === "failed" && (
                  <Button variant="ghost" onClick={() => void retry(request.id)}>
                    Retry
                  </Button>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
