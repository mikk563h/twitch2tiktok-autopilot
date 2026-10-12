import { SignJWT, jwtVerify } from "jose";
import { config } from "./config";
import { safeEqual, verifyPassword } from "./crypto";

export const SESSION_COOKIE = "t2t_session";
const SESSION_DAYS = 14;

function secret() {
  return new TextEncoder().encode(config.sessionSecret);
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

export function checkPassword(password: string): boolean {
  if (config.adminPasswordHash) return verifyPassword(password, config.adminPasswordHash);
  if (config.adminPassword) return safeEqual(password, config.adminPassword);
  return false;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: config.appUrl.startsWith("https://"),
  path: "/",
  maxAge: SESSION_DAYS * 86400,
};
