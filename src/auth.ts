import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { SESSION_COOKIE, SESSION_DAYS } from "./config";
import { getSetting, getUserById, getUserByToken, type UserRow } from "./db";

export type PublicUser = { id: string; username: string; isAdmin: boolean };

declare global {
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

function secret(): string {
  const value = getSetting("cookie_secret");
  if (!value) throw new Error("Cookie secret is missing.");
  return value;
}

export function signSession(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 }),
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      uid?: string;
      exp?: number;
    };
    if (!parsed.uid || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed.uid;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, userId: string) {
  res.cookie(SESSION_COOKIE, signSession(userId), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function toPublicUser(user: UserRow): PublicUser {
  return { id: user.id, username: user.username, isAdmin: user.is_admin === 1 };
}

export function loadUser(req: Request): UserRow | null {
  const header = req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    const token = header.slice(7).trim();
    if (!token) return null;
    return getUserByToken(token);
  }
  const userId = readSession(req.cookies?.[SESSION_COOKIE] as string | undefined);
  if (!userId) return null;
  return getUserById(userId);
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = loadUser(req);
  if (!user) {
    res.status(401).json({ error: "Sign in required." });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.is_admin !== 1) {
    res.status(403).json({ error: "Admin access is required." });
    return;
  }
  next();
}
