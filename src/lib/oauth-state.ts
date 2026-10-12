import { randomToken, safeEqual } from "./crypto";
import { config } from "./config";

export const stateCookie = (provider: string) => `t2t_oauth_${provider}`;
export const stateCookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: config.appUrl.startsWith("https://"), path: "/", maxAge: 600 };
export const newState = () => randomToken(24);
export const stateMatches = (a: string | undefined | null, b: string | undefined | null) => !!a && !!b && safeEqual(a, b);
