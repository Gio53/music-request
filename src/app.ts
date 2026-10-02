import path from "path";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import {
  clearSessionCookie,
  loadUser,
  requireAdmin,
  requireUser,
  setSessionCookie,
  toPublicUser,
} from "./auth";
import {
  enabledLibraryIds,
  getRequest,
  getSetting,
  isSetupComplete,
  listAlbumsForArtist,
  listArtists,
  listLibraries,
  listRequests,
  regenerateToken,
  replaceLibraries,
  setEnabledLibraries,
  setSetting,
  upsertUser,
} from "./db";
import { HttpError } from "./errors";
import {
  authenticate,
  fetchMusicFolders,
  fetchPrimaryImage,
  normalizeUrl,
  refreshJellyfinLibrary,
  saveDiscoveredLibraries,
  syncLibrary,
} from "./jellyfin";
import { lidarrOptions, testLidarr } from "./lidarr";
import { buildSearch, createRequest, retryRequest, toRequestJson } from "./request-service";

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function setupLocked(_req: Request, res: Response, next: NextFunction) {
  if (isSetupComplete()) {
    res.status(403).json({ error: "Setup is already finished. Change settings after you sign in." });
    return;
  }
  next();
}

function requireReady(_req: Request, res: Response, next: NextFunction) {
  if (!isSetupComplete()) {
    res.status(503).json({ error: "Finish the setup wizard before using Music Request." });
    return;
  }
  next();
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: true,
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/setup/status", (_req, res) => {
    res.json({ setupRequired: !isSetupComplete() });
  });

  app.post(
    "/api/setup/jellyfin",
    setupLocked,
    asyncRoute(async (req, res) => {
      const url = String(req.body?.url || "");
      const username = String(req.body?.username || "");
      const password = String(req.body?.password || "");
      if (!url || !username || !password) {
        throw new HttpError(400, "Jellyfin URL, username, and password are required.");
      }
      const auth = await authenticate(normalizeUrl(url), username, password);
      setSetting("jellyfin_url", normalizeUrl(url));
      setSetting("jellyfin_username", username);
      setSetting("jellyfin_password", password);
      setSetting("jellyfin_access_token", auth.AccessToken);
      setSetting("jellyfin_admin_id", auth.User.Id);
      setSetting("jellyfin_admin_name", auth.User.Name);
      setSetting("jellyfin_is_admin", auth.User.Policy?.IsAdministrator ? "1" : "0");
      const libraries = await fetchMusicFolders(normalizeUrl(url), auth.AccessToken);
      replaceLibraries(
        libraries.map((folder) => ({
          jellyfinId: folder.Id,
          name: folder.Name,
          path: folder.Path || null,
        })),
      );
      res.json({
        username: auth.User.Name,
        isAdmin: Boolean(auth.User.Policy?.IsAdministrator),
        libraries: listLibraries().map(libraryJson),
      });
    }),
  );

  app.post(
    "/api/setup/libraries",
    setupLocked,
    asyncRoute(async (req, res) => {
      const ids = arrayOfStrings(req.body?.libraryIds);
      if (ids.length === 0) throw new HttpError(400, "Select at least one music library.");
      setEnabledLibraries(ids);
      res.json({ libraries: listLibraries().map(libraryJson) });
    }),
  );

  app.post(
    "/api/integrations/lidarr/options",
    asyncRoute(async (req, res) => {
      if (isSetupComplete()) {
        const user = loadUser(req);
        if (!user) throw new HttpError(401, "Sign in required.");
        if (user.is_admin !== 1) throw new HttpError(403, "Admin access is required.");
      }
      const url = String(req.body?.url || getSetting("lidarr_url") || "");
      const apiKey = String(req.body?.apiKey || getSetting("lidarr_api_key") || "");
      if (!url || !apiKey) throw new HttpError(400, "Lidarr URL and API key are required.");
      const options = await lidarrOptions(url, apiKey);
      res.json(options);
    }),
  );

  app.post(
    "/api/setup/lidarr",
    setupLocked,
    asyncRoute(async (req, res) => {
      await saveLidarr(req.body);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/setup/finish",
    setupLocked,
    asyncRoute(async (req, res) => {
      if (!getSetting("jellyfin_url") || !getSetting("lidarr_url")) {
        throw new HttpError(400, "Connect Jellyfin and Lidarr before finishing setup.");
      }
      if (enabledLibraryIds().length === 0) {
        throw new HttpError(400, "Select at least one music library.");
      }
      if (getSetting("jellyfin_is_admin") !== "1") {
        throw new HttpError(400, "The Jellyfin account used for setup must be an administrator.");
      }
      await syncEnabledLibraries();
      const user = upsertUser({
        jellyfinUserId: getSetting("jellyfin_admin_id") || "",
        username: getSetting("jellyfin_admin_name") || getSetting("jellyfin_username") || "admin",
        isAdmin: true,
      });
      setSetting("setup_complete", "1");
      setSessionCookie(res, user.id);
      res.json({ ok: true, user: toPublicUser(user) });
    }),
  );

  app.post(
    "/api/auth/login",
    requireReady,
    asyncRoute(async (req, res) => {
      const username = String(req.body?.username || "");
      const password = String(req.body?.password || "");
      if (!username || !password) throw new HttpError(400, "Username and password are required.");
      const url = getSetting("jellyfin_url");
      if (!url) throw new HttpError(400, "Jellyfin is not configured.");
      const auth = await authenticate(url, username, password);
      const user = upsertUser({
        jellyfinUserId: auth.User.Id,
        username: auth.User.Name,
        isAdmin: Boolean(auth.User.Policy?.IsAdministrator),
      });
      setSessionCookie(res, user.id);
      res.json(toPublicUser(user));
    }),
  );

  app.post("/api/auth/logout", (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/me", requireReady, requireUser, (req, res) => {
    res.json(toPublicUser(req.user!));
  });

  app.get("/api/me/token", requireReady, requireUser, (req, res) => {
    res.json({ token: req.user!.api_token });
  });

  app.post("/api/me/token", requireReady, requireUser, (req, res) => {
    const token = regenerateToken(req.user!.id);
    res.json({ token });
  });

  app.get("/api/settings", requireReady, requireUser, requireAdmin, (_req, res) => {
    res.json(settingsJson());
  });

  app.put(
    "/api/settings",
    requireReady,
    requireUser,
    requireAdmin,
    asyncRoute(async (req, res) => {
      if (req.body?.jellyfin) await saveJellyfin(req.body.jellyfin, true);
      if (req.body?.lidarr) await saveLidarr(req.body.lidarr);
      if (Array.isArray(req.body?.libraryIds)) setEnabledLibraries(arrayOfStrings(req.body.libraryIds));
      res.json(settingsJson());
    }),
  );

  app.post(
    "/api/settings/test-jellyfin",
    requireReady,
    requireUser,
    requireAdmin,
    asyncRoute(async (req, res) => {
      const url = String(req.body?.url || "");
      const username = String(req.body?.username || "");
      const password = String(req.body?.password || getSetting("jellyfin_password") || "");
      const auth = await authenticate(url, username, password);
      const libraries = await fetchMusicFolders(normalizeUrl(url), auth.AccessToken);
      res.json({
        ok: true,
        username: auth.User.Name,
        isAdmin: Boolean(auth.User.Policy?.IsAdministrator),
        libraries: libraries.map((folder) => ({
          jellyfinId: folder.Id,
          name: folder.Name,
          path: folder.Path || null,
        })),
      });
    }),
  );

  app.post(
    "/api/settings/test-lidarr",
    requireReady,
    requireUser,
    requireAdmin,
    asyncRoute(async (req, res) => {
      const url = String(req.body?.url || "");
      const apiKey = String(req.body?.apiKey || getSetting("lidarr_api_key") || "");
      const status = await testLidarr(url, apiKey);
      res.json({ ok: true, ...status });
    }),
  );

  app.post(
    "/api/settings/sync",
    requireReady,
    requireUser,
    requireAdmin,
    asyncRoute(async (req, res) => {
      const count = await syncEnabledLibraries();
      res.json({ ok: true, items: count, libraries: listLibraries().map(libraryJson) });
    }),
  );

  app.post(
    "/api/settings/refresh",
    requireReady,
    requireUser,
    requireAdmin,
    asyncRoute(async (_req, res) => {
      await refreshJellyfinLibrary();
      res.json({ ok: true });
    }),
  );

  app.get("/api/library/artists", requireReady, requireUser, (_req, res) => {
    res.json({
      artists: listArtists().map((artist) => ({
        id: artist.jellyfin_id,
        name: artist.name,
        musicbrainzId: artist.musicbrainz_id,
        hasImage: Boolean(artist.image_tag),
      })),
    });
  });

  app.get("/api/library/artists/:id/albums", requireReady, requireUser, (req, res) => {
    const artist = listArtists().find((item) => item.jellyfin_id === req.params.id);
    if (!artist) {
      res.status(404).json({ error: "Artist not found in the synced library." });
      return;
    }
    res.json({
      artist: { id: artist.jellyfin_id, name: artist.name, musicbrainzId: artist.musicbrainz_id },
      albums: listAlbumsForArtist(req.params.id).map((album) => ({
        id: album.jellyfin_id,
        name: album.name,
        artist: album.artist_name,
        musicbrainzId: album.musicbrainz_id,
        hasImage: Boolean(album.image_tag),
        inLibrary: true,
      })),
    });
  });

  app.get(
    "/api/search",
    requireReady,
    requireUser,
    asyncRoute(async (req, res) => {
      const term = String(req.query.term || "").trim();
      if (term.length < 2) throw new HttpError(400, "Type at least 2 characters to search.");
      res.json(await buildSearch(term, req.user!.id));
    }),
  );

  app.post(
    "/api/requests",
    requireReady,
    requireUser,
    asyncRoute(async (req, res) => {
      const row = await createRequest(req.user!.id, req.body || {});
      res.status(201).json(toRequestJson(row));
    }),
  );

  app.get("/api/requests", requireReady, requireUser, (req, res) => {
    const mine = String(req.query.mine || "") === "true" || req.user!.is_admin !== 1;
    const rows = mine ? listRequests(req.user!.id) : listRequests();
    res.json(rows.map(toRequestJson));
  });

  app.get("/api/requests/:id", requireReady, requireUser, (req, res) => {
    const row = getRequest(req.params.id);
    if (!row) {
      res.status(404).json({ error: "Request not found." });
      return;
    }
    if (req.user!.is_admin !== 1 && row.user_id !== req.user!.id) {
      res.status(404).json({ error: "Request not found." });
      return;
    }
    res.json(toRequestJson(row));
  });

  app.post(
    "/api/requests/:id/retry",
    requireReady,
    requireUser,
    requireAdmin,
    asyncRoute(async (req, res) => {
      const row = await retryRequest(req.params.id);
      res.json(toRequestJson(row));
    }),
  );

  app.get(
    "/api/images/:itemId",
    requireReady,
    requireUser,
    asyncRoute(async (req, res) => {
      const image = await fetchPrimaryImage(req.params.itemId);
      if (!image) {
        res.status(404).end();
        return;
      }
      res.setHeader("Content-Type", image.contentType);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(image.bytes);
    }),
  );

  const clientDist = path.join(__dirname, "../client/dist");
  app.use(express.static(clientDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, "index.html"), (error) => {
      if (error) next();
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && (error as { status?: number }).status === 400) {
      res.status(400).json({ error: "The request body is not valid JSON." });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Something went wrong. Try again." });
  });

  return app;
}

function libraryJson(library: { jellyfin_id: string; name: string; path: string | null; enabled: number }) {
  return {
    id: library.jellyfin_id,
    name: library.name,
    path: library.path,
    enabled: library.enabled === 1,
  };
}

function settingsJson() {
  const apiKey = getSetting("lidarr_api_key");
  return {
    jellyfinUrl: getSetting("jellyfin_url") || "",
    jellyfinUsername: getSetting("jellyfin_username") || "",
    jellyfinPasswordSet: Boolean(getSetting("jellyfin_password")),
    lidarrUrl: getSetting("lidarr_url") || "",
    lidarrApiKeyHint: apiKey ? `••••${apiKey.slice(-4)}` : "",
    lidarrRootFolder: getSetting("lidarr_root_folder") || "",
    lidarrQualityProfileId: Number(getSetting("lidarr_quality_profile_id") || 0),
    lidarrMetadataProfileId: Number(getSetting("lidarr_metadata_profile_id") || 0),
    libraries: listLibraries().map(libraryJson),
  };
}

async function saveJellyfin(
  body: { url?: string; username?: string; password?: string },
  keepPassword: boolean,
) {
  const url = String(body.url || "");
  const username = String(body.username || "");
  const password = String(body.password || (keepPassword ? getSetting("jellyfin_password") : "") || "");
  if (!url || !username || !password) {
    throw new HttpError(400, "Jellyfin URL, username, and password are required.");
  }
  const auth = await authenticate(normalizeUrl(url), username, password);
  if (!auth.User.Policy?.IsAdministrator) {
    throw new HttpError(400, "Music Request needs a Jellyfin administrator account for library sync.");
  }
  setSetting("jellyfin_url", normalizeUrl(url));
  setSetting("jellyfin_username", username);
  setSetting("jellyfin_password", password);
  setSetting("jellyfin_access_token", auth.AccessToken);
  setSetting("jellyfin_admin_id", auth.User.Id);
  setSetting("jellyfin_admin_name", auth.User.Name);
  setSetting("jellyfin_is_admin", "1");
  await saveDiscoveredLibraries();
}

async function saveLidarr(body: {
  url?: string;
  apiKey?: string;
  rootFolder?: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
}) {
  const url = String(body.url || "");
  const apiKey = String(body.apiKey || getSetting("lidarr_api_key") || "");
  const rootFolder = String(body.rootFolder || "");
  const qualityProfileId = Number(body.qualityProfileId || 0);
  const metadataProfileId = Number(body.metadataProfileId || 0);
  if (!url || !apiKey) throw new HttpError(400, "Lidarr URL and API key are required.");
  if (!rootFolder || !qualityProfileId) {
    throw new HttpError(400, "Choose a Lidarr root folder and quality profile.");
  }
  await testLidarr(url, apiKey);
  setSetting("lidarr_url", normalizeUrl(url));
  setSetting("lidarr_api_key", apiKey);
  setSetting("lidarr_root_folder", rootFolder);
  setSetting("lidarr_quality_profile_id", String(qualityProfileId));
  setSetting("lidarr_metadata_profile_id", String(metadataProfileId || ""));
}

async function syncEnabledLibraries(): Promise<number> {
  await saveDiscoveredLibraries();
  let count = 0;
  for (const libraryId of enabledLibraryIds()) {
    count += await syncLibrary(libraryId);
  }
  return count;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}
