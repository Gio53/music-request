import { FormEvent, useState } from "react";
import { api, ApiError } from "../api";
import { Alert, Button, Card, TextField } from "../components/ui";

export function Login({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
        }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-3xl font-bold">Sign in</h1>
      <p className="mt-2 text-muted">Use the same username and password as Jellyfin.</p>
      <Card className="mt-8">
        <form className="space-y-4" onSubmit={submit}>
          {error && <Alert>{error}</Alert>}
          <TextField label="Username" name="username" autoComplete="username" required />
          <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
          <Button disabled={busy} type="submit">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
