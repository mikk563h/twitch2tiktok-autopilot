import { NextResponse, type NextRequest } from "next/server";
import { twitchAuthorizeUrl } from "@/lib/twitch/oauth";
import { newState, stateCookie, stateCookieOptions } from "@/lib/oauth-state";
import { config } from "@/lib/config";

export async function GET(req: NextRequest) {
  if (!config.twitchClientId) return NextResponse.redirect(new URL("/accounts?error=twitch_not_configured", req.url));
  const role = req.nextUrl.searchParams.get("role") === "broadcaster" ? "broadcaster" : "editor";
  const state = newState();
  const res = NextResponse.redirect(twitchAuthorizeUrl(state, role));
  res.cookies.set(stateCookie("twitch"), state, stateCookieOptions);
  return res;
}
