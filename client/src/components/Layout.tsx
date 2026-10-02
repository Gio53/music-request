import { NavLink, Outlet } from "react-router-dom";
import type { PublicUser } from "../api";
import { api } from "../api";
import { Button } from "./ui";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--ring)] ${
    isActive ? "bg-primary text-on-primary" : "text-text hover:bg-surface-2"
  }`;

export function Layout({ user, onLogout }: { user: PublicUser; onLogout: () => void }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-4 md:px-8">
          <span className="text-lg font-bold">Music Request</span>
          <nav className="flex flex-1 flex-wrap gap-2" aria-label="Main">
            <NavLink className={linkClass} to="/library">
              Library
            </NavLink>
            <NavLink className={linkClass} to="/search">
              Search
            </NavLink>
            <NavLink className={linkClass} to="/requests">
              My Requests
            </NavLink>
            {user.isAdmin && (
              <NavLink className={linkClass} to="/admin/requests">
                All Requests
              </NavLink>
            )}
            {user.isAdmin && (
              <NavLink className={linkClass} to="/settings">
                Settings
              </NavLink>
            )}
          </nav>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">{user.username}</span>
            <Button
              variant="ghost"
              onClick={() => {
                void api("/api/auth/logout", { method: "POST" }).finally(onLogout);
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 md:px-8">
        <Outlet />
      </main>
    </div>
  );
}
