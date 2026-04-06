import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "personel_auth";

function authPassword(): string {
  return process.env.APP_AUTH_PASSWORD ?? "";
}

function authSecret(): string {
  return process.env.APP_AUTH_SECRET ?? "";
}

export function isAuthConfigured(): boolean {
  return authPassword().length > 0 && authSecret().length > 0;
}

function expectedToken(): string {
  const payload = `${authPassword()}::${authSecret()}`;
  return createHash("sha256").update(payload).digest("hex");
}

export function buildSessionTokenForPassword(password: string): string {
  const payload = `${password}::${authSecret()}`;
  return createHash("sha256").update(payload).digest("hex");
}

export function isPasswordValid(password: string): boolean {
  if (!isAuthConfigured()) return false;
  const provided = buildSessionTokenForPassword(password);
  const expected = expectedToken();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isSessionTokenValid(token: string | undefined): boolean {
  if (!token || !isAuthConfigured()) return false;
  const expected = expectedToken();
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
