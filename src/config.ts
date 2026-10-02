import path from "path";

export const PORT = Number(process.env.PORT || 5656);
export const CONFIG_DIR = process.env.CONFIG_DIR || path.join(process.cwd(), "config");
export const DB_PATH = path.join(CONFIG_DIR, "music-request.db");
export const CLIENT_NAME = "MusicRequest";
export const CLIENT_VERSION = "1.0";
export const SESSION_COOKIE = "mr_session";
export const SESSION_DAYS = 14;
