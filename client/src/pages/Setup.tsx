import { FormEvent, useState } from "react";
import { api, ApiError, type LibraryFolder, type LidarrOptions } from "../api";
import { Alert, Button, Card, SelectField, TextField } from "../components/ui";

export function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [libraries, setLibraries] = useState<LibraryFolder[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [options, setOptions] = useState<LidarrOptions | null>(null);
  const [lidarr, setLidarr] = useState({
    url: "",
    apiKey: "",
    rootFolder: "",
    qualityProfileId: 0,
    metadataProfileId: 0,
  });

  async function connectJellyfin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ isAdmin: boolean; libraries: LibraryFolder[] }>("/api/setup/jellyfin", {
        method: "POST",
        body: JSON.stringify({
          url: form.get("url"),
          username: form.get("username"),
          password: form.get("password"),
        }),
      });
      if (!result.isAdmin) {
        setError("That Jellyfin account is not an administrator. Use an admin account for setup.");
        return;
      }
      if (result.libraries.length === 0) {
        setError("Jellyfin did not return any music libraries. Add a music library in Jellyfin, then try again.");
        return;
      }
      setLibraries(result.libraries);
      setSelected(result.libraries.map((library) => library.id));
      setStep(2);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach Jellyfin.");
    } finally {
      setBusy(false);
    }
  }

  async function saveLibraries() {
    setError("");
    setBusy(true);
    try {
      await api("/api/setup/libraries", {
        method: "POST",
        body: JSON.stringify({ libraryIds: selected }),
      });
      setStep(3);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save libraries.");
    } finally {
      setBusy(false);
    }
  }

  async function loadLidarrOptions() {
    setError("");
    setBusy(true);
    try {
      const next = await api<LidarrOptions>("/api/integrations/lidarr/options", {
        method: "POST",
        body: JSON.stringify({ url: lidarr.url, apiKey: lidarr.apiKey }),
      });
      setOptions(next);
      setLidarr((current) => ({
        ...current,
        rootFolder: next.rootFolders[0]?.path || "",
        qualityProfileId: next.qualityProfiles[0]?.id || 0,
        metadataProfileId: next.metadataProfiles[0]?.id || 0,
      }));
    } catch (err) {
      setOptions(null);
      setError(err instanceof ApiError ? err.message : "Lidarr is unreachable.");
    } finally {
      setBusy(false);
    }
  }

  async function saveLidarr() {
    setError("");
    setBusy(true);
    try {
      await api("/api/setup/lidarr", { method: "POST", body: JSON.stringify(lidarr) });
      setStep(4);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save Lidarr.");
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setError("");
    setBusy(true);
    try {
      await api("/api/setup/finish", { method: "POST" });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Setup could not finish.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <p className="text-sm font-semibold text-muted">Step {step} of 4</p>
      <h1 className="mt-2 text-3xl font-bold">Set up Music Request</h1>
      <p className="mt-2 text-muted">Connect Jellyfin and Lidarr. Nothing in your music folders is changed.</p>
      <Card className="mt-8">
        {error && (
          <div className="mb-4">
            <Alert>{error}</Alert>
          </div>
        )}
        {step === 1 && (
          <form className="space-y-4" onSubmit={connectJellyfin}>
            <TextField label="Jellyfin URL" name="url" placeholder="http://192.168.1.10:8096" required />
            <TextField label="Admin username" name="username" autoComplete="username" required />
            <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
            <Button disabled={busy} type="submit">
              {busy ? "Connecting…" : "Test and continue"}
            </Button>
          </form>
        )}
        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-muted">Choose the music libraries to browse and match against requests.</p>
            <ul className="space-y-2">
              {libraries.map((library) => (
                <li key={library.id}>
                  <label className="flex min-h-11 items-center gap-3 rounded-lg border border-line px-4">
                    <input
                      checked={selected.includes(library.id)}
                      type="checkbox"
                      onChange={(event) => {
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, library.id]
                            : current.filter((id) => id !== library.id),
                        );
                      }}
                    />
                    <span>
                      <span className="font-semibold">{library.name}</span>
                      {library.path && <span className="mt-1 block text-xs text-muted">{library.path}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <Button disabled={busy || selected.length === 0} onClick={() => void saveLibraries()}>
              Continue
            </Button>
          </div>
        )}
        {step === 3 && (
          <div className="space-y-4">
            <TextField
              label="Lidarr URL"
              value={lidarr.url}
              placeholder="http://192.168.1.10:8686"
              onChange={(event) => setLidarr({ ...lidarr, url: event.target.value })}
            />
            <TextField
              label="API key"
              type="password"
              value={lidarr.apiKey}
              onChange={(event) => setLidarr({ ...lidarr, apiKey: event.target.value })}
            />
            <Button disabled={busy} variant="ghost" onClick={() => void loadLidarrOptions()}>
              {busy ? "Testing…" : "Test connection"}
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
                    onChange={(event) =>
                      setLidarr({ ...lidarr, metadataProfileId: Number(event.target.value) })
                    }
                  >
                    {options.metadataProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </SelectField>
                )}
                <Button disabled={busy} onClick={() => void saveLidarr()}>
                  Save Lidarr
                </Button>
              </>
            )}
          </div>
        )}
        {step === 4 && (
          <div className="space-y-4">
            <p>Sync the selected libraries, then open Music Request as the Jellyfin admin you just connected.</p>
            <Button disabled={busy} onClick={() => void finish()}>
              {busy ? "Syncing…" : "Sync and finish"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
