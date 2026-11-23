// Accounts and sessions. Passwords are stored only as scrypt hashes.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { store } from "./store";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const RESERVED = new Set(["moderator", "anonymous"]);

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString("base64");
}

function newSession(name: string) {
  const token = randomBytes(32).toString("base64url");
  store.db.sessions[token] = { name, createdAt: new Date().toISOString() };
  store.save();
  return token;
}

function readCredentials(body: Record<string, unknown>) {
  const name = String(body.name ?? "").trim();
  const password = String(body.password ?? "");
  if (!name || name.length > 40) throw new HttpError(400, "Use a name of 1 to 40 characters.");
  if (password.length < 6) throw new HttpError(400, "Use a password of at least 6 characters.");
  return { name, password };
}

export function signUp(body: Record<string, unknown>) {
  const { name, password } = readCredentials(body);
  if (RESERVED.has(name.toLowerCase())) throw new HttpError(400, "That name is reserved.");
  const key = name.toLowerCase();
  if (store.db.users[key]) throw new HttpError(409, "That name is taken. Log in, or choose another name.");
  const salt = randomBytes(16).toString("base64");
  store.db.users[key] = { name, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
  store.save();
  return { name, token: newSession(name) };
}

export function logIn(body: Record<string, unknown>) {
  const { name, password } = readCredentials(body);
  const user = store.db.users[name.toLowerCase()];
  const expected = user ? Buffer.from(user.hash, "base64") : randomBytes(64);
  const actual = Buffer.from(hashPassword(password, user?.salt ?? "none"), "base64");
  if (!user || !timingSafeEqual(expected, actual)) throw new HttpError(401, "Wrong name or password.");
  return { name: user.name, token: newSession(user.name) };
}

export function logOut(token: string) {
  delete store.db.sessions[token];
  store.save();
}

/** The signed-in member's name, or a 401. */
export function requireUser(token: string): string {
  const session = token ? store.db.sessions[token] : undefined;
  if (!session) throw new HttpError(401, "Please log in again.");
  return session.name;
}

export function bearer(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match ? match[1].trim() : "";
}
