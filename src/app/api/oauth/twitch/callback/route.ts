import { NextResponse, type NextRequest } from "next/server";
import { exchangeTwitchCode } from "@/lib/twitch/oauth";
import { stateCookie, stateMatches } from "@/lib/oauth-state";
import { record, errMsg } from "@/lib/log";
import { config } from "@/lib/config";

export async function GET(req: NextRequest) {
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/accounts?${q}`, config.appUrl));
    res.cookies.delete(stateCookie("twitch"));
    return res;
  };
  const p = req.nextUrl.searchParams;
  if (p.get("error")) return back(`error=${encodeURIComponent(p.get("error_description") ?? p.get("error")!)}`);
  if (!stateMatches(p.get("state"), req.cookies.get(stateCookie("twitch"))?.value)) return back("error=Ugyldig%20OAuth-state%20(pr%C3%B8v%20igen)");
  try {
    const info = await exchangeTwitchCode(p.get("code") ?? "");
    await record("info", "oauth", `Twitch forbundet som ${info.login}`);
    return back("ok=twitch");
  } catch (err) {
    await record("error", "oauth", `Twitch OAuth fejlede: ${errMsg(err)}`);
    return back(`error=${encodeURIComponent(errMsg(err))}`);
  }
}
