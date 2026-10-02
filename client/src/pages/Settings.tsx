import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, type LibraryFolder, type LidarrOptions, type Settings } from "../api";
import { Alert, Button, Card, SelectField, TextField } from "../components/ui";

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<LidarrOptions | null>(null);
  const [libraries, setLibraries] = useState<string[]>([]);
  const [jellyfin, setJellyfin] = useState({ url: "", username: "", password: "" });
  const [lidarr, setLidarr] = useState({
    url: "",
    apiKey: "",
    rootFolder: "",
    qualityProfileId: 0,
    metadataProfileId: 0,
  });

  useEffect(() => {
    api<Settings>("/api/settings")
      .then((data) => {
        setSettings(data);
        setLibraries(data.libraries.filter((library) => library.enabled).map((library) => library.id));
        setJellyfin({ url: data.jellyfinUrl, username: data.jellyfinUsername, password: "" });
        setLidarr({
          url: data.lidarrUrl,
          apiKey: "",
          rootFolder: data.lidarrRootFolder,
          qualityProfileId: data.lidarrQualityProfileId,
          metadataProfileId: data.lidarrMetadataProfileId,
        });
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Could not load settings."));
  }, []);

  async function testJellyfin(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const result = await api<{ username: string }>("/api/settings/test-jellyfin", {
        method: "POST",
        body: JSON.stringify(jellyfin),
      });
      setMessage(`Jellyfin accepted ${result.username}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Jellyfin is unreachable.");
    } finally {
      setBusy(false);
    }
  }

  async function saveJellyfin() {
    setBusy(true);
    setError("");
    try {
      const next = await api<Settings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ jellyfin, libraryIds: libraries }),
      });
      setSettings(next);
      setMessage("Jellyfin settings saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save Jellyfin.");
    } finally {
      setBusy(false);
    }
  }

  async function testLidarr() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const status = await api<{ appName: string; version: string }>("/api/settings/test-lidarr", {
        method: "POST",
        body: JSON.stringify({ url: lidarr.url, apiKey: lidarr.apiKey }),
      });
      const next = await api<LidarrOptions>("/api/integrations/lidarr/options", {
        method: "POST",
        body: JSON.stringify({ url: lidarr.url, apiKey: lidarr.apiKey }),
      });
      setOptions(next);
      setMessage(`${status.appName} ${status.version} is reachable.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Lidarr is unreachable.");
    } finally {
      setBusy(false);
    }
  }

  async function saveLidarr() {
    setBusy(true);
    setError("");
    try {
      const next = await api<Settings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ lidarr }),
      });
      setSettings(next);
      setMessage("Lidarr settings saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save Lidarr.");
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ items: number; libraries: LibraryFolder[] }>("/api/settings/sync", {
        method: "POST",
      });
      setMessage(`Synced ${result.items} artists and albums.`);
      if (settings) setSettings({ ...settings, libraries: result.libraries });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sync failed.");
    } finally {
      setBusy(false);
    }
  }

  function toggleLibrary(id: string, enabled: boolean) {
    setLibraries((current) => (enabled ? [...current, id] : current.filter((item) => item !== id)));
  }

  if (!settings) {
    return error ? <Alert>{error}</Alert> : <p className="text-muted">Loading settings…</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="mt-2 text-muted">Jellyfin and Lidarr credentials stay in the config volume on this server.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      {message && <p className="text-sm">{message}</p>}
      <Card>
        <h2 className="text-xl font-semibold">Jellyfin</h2>
        <form className="mt-4 space-y-4" onSubmit={testJellyfin}>
          <TextField label="URL" value={jellyfin.url} onChange={(event) => setJellyfin({ ...jellyfin, url: event.target.value })} />
          <TextField
            label="Admin username"
            value={jellyfin.username}
            onChange={(event) => setJellyfin({ ...jellyfin, username: event.target.value })}
          />
          <TextField
            label="Password"
            type="password"
            placeholder={settings.jellyfinPasswordSet ? "Saved — leave blank to keep it" : ""}
            value={jellyfin.password}
            onChange={(event) => setJellyfin({ ...jellyfin, password: event.target.value })}
          />
          <div className="flex flex-wrap gap-3">
            <Button disabled={busy} type="submit" variant="ghost">
              Test connection
            </Button>
            <Button disabled={busy} type="button" onClick={() => void saveJellyfin()}>
              Save Jellyfin
            </Button>
          </div>
        </form>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">Music libraries</h2>
        <ul className="mt-4 space-y-2">
          {settings.libraries.map((library) => (
            <li key={library.id}>
              <label className="flex min-h-11 items-center gap-3">
                <input
                  checked={libraries.includes(library.id)}
                  type="checkbox"
                  onChange={(event) => toggleLibrary(library.id, event.target.checked)}
                />
                <span className="font-semibold">{library.name}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button disabled={busy} variant="ghost" onClick={() => void saveJellyfin()}>
            Save selection
          </Button>
          <Button disabled={busy} onClick={() => void sync()}>
            {busy ? "Syncing…" : "Sync libraries"}
          </Button>
        </div>
      </Card>
      <Card>
        <h2 className="text-xl font-semibold">Lidarr</h2>
        <div className="mt-4 space-y-4">
          <TextField label="URL" value={lidarr.url} onChange={(event) => setLidarr({ ...lidarr, url: event.target.value })} />
          <TextField
            label="API key"
            type="password"
            placeholder={settings.lidarrApiKeyHint || "API key"}
            value={lidarr.apiKey}
            onChange={(event) => setLidarr({ ...lidarr, apiKey: event.target.value })}
          />
          <Button disabled={busy} variant="ghost" onClick={() => void testLidarr()}>
            Test connection
          </Button>
          {options && (
            <>
              <SelectField
                label="Root folder"
                value={lidarr.rootFolder}
                onChange={(event) => setLidarr({ ...lidarr, rootFolder: event.target.value })}
              >
                {options.rootFolders.map((folder) => (
                  <option key={folder.path} value={folder.path}>
                    {folder.path}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Quality profile"
                value={lidarr.qualityProfileId}
                onChange={(event) => setLidarr({ ...lidarr, qualityProfileId: Number(event.target.value) })}
              >
                {options.qualityProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </SelectField>
              {options.metadataProfiles.length > 0 && (
                <SelectField
                  label="Metadata profile"
                  value={lidarr.metadataProfileId}
                  onChange={(event) => setLidarr({ ...lidarr, metadataProfileId: Number(event.target.value) })}
                >
                  {options.metadataProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </SelectField>
              )}
            </>
          )}
          <Button disabled={busy} onClick={() => void saveLidarr()}>
            Save Lidarr
          </Button>
        </div>
      </Card>
    </div>
  );
}
