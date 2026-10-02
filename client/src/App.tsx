import { createContext, useContext, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, type PublicUser } from "./api";
import { Layout } from "./components/Layout";
import { Library, ArtistPage } from "./pages/Library";
import { Login } from "./pages/Login";
import { RequestsPage } from "./pages/Requests";
import { SearchPage } from "./pages/Search";
import { SettingsPage } from "./pages/Settings";
import { Setup } from "./pages/Setup";

type Session = {
  user: PublicUser | null;
  setupRequired: boolean;
  ready: boolean;
  refresh: () => Promise<void>;
};

const SessionContext = createContext<Session>({
  user: null,
  setupRequired: false,
  ready: false,
  refresh: async () => undefined,
});

export function useSession() {
  return useContext(SessionContext);
}

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [ready, setReady] = useState(false);

  async function refresh() {
    const status = await api<{ setupRequired: boolean }>("/api/setup/status");
    setSetupRequired(status.setupRequired);
    if (status.setupRequired) {
      setUser(null);
      setReady(true);
      return;
    }
    try {
      setUser(await api<PublicUser>("/api/me"));
    } catch {
      setUser(null);
    }
    setReady(true);
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (!ready) {
    return <p className="p-8 text-muted">Loading…</p>;
  }

  return (
    <SessionContext.Provider value={{ user, setupRequired, ready, refresh }}>
      <Routes>
        <Route element={<SetupGate />} path="/setup" />
        <Route element={<LoginGate />} path="/login" />
        <Route element={user ? <Layout user={user} onLogout={() => setUser(null)} /> : <Navigate to="/login" replace />}>
          <Route index element={<Navigate to="/library" replace />} />
          <Route element={<Library />} path="/library" />
          <Route element={<ArtistPage />} path="/library/:artistId" />
          <Route element={<SearchPage />} path="/search" />
          <Route element={<RequestsPage scope="mine" />} path="/requests" />
          <Route element={<AdminRoute />} path="/admin/requests" />
          <Route element={<AdminSettings />} path="/settings" />
        </Route>
        <Route element={<Navigate to={setupRequired ? "/setup" : user ? "/library" : "/login"} replace />} path="*" />
      </Routes>
    </SessionContext.Provider>
  );
}

function SetupGate() {
  const { setupRequired, refresh } = useSession();
  const navigate = useNavigate();
  if (!setupRequired) return <Navigate to="/library" replace />;
  return (
    <Setup
      onDone={async () => {
        await refresh();
        navigate("/library");
      }}
    />
  );
}

function LoginGate() {
  const { setupRequired, user, refresh } = useSession();
  const navigate = useNavigate();
  if (setupRequired) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to="/library" replace />;
  return (
    <Login
      onDone={async () => {
        await refresh();
        navigate("/library");
      }}
    />
  );
}

function AdminRoute() {
  const { user } = useSession();
  if (!user?.isAdmin) return <Navigate to="/requests" replace />;
  return <RequestsPage scope="all" />;
}

function AdminSettings() {
  const { user } = useSession();
  if (!user?.isAdmin) return <Navigate to="/requests" replace />;
  return <SettingsPage />;
}
