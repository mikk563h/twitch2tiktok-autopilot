import { NextResponse, type NextRequest } from "next/server";
import { authorizeUrl } from "@/lib/tiktok/api";
import { newState, stateCookie, stateCookieOptions } from "@/lib/oauth-state";
import { config } from "@/lib/config";

export async function GET(req: NextRequest) {
  if (!config.tiktokClientKey) return NextResponse.redirect(new URL("/accounts?error=tiktok_not_configured", req.url));
  const state = newState();
  const res = NextResponse.redirect(authorizeUrl(state));
  res.cookies.set(stateCookie("tiktok"), state, stateCookieOptions);
  return res;
}
