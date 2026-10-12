import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode } from "@/lib/tiktok/api";
import { patchTikTokRuntime } from "@/lib/tiktok/state";
import { stateCookie, stateMatches } from "@/lib/oauth-state";
import { record, errMsg } from "@/lib/log";
import { config } from "@/lib/config";

export async function GET(req: NextRequest) {
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/accounts?${q}`, config.appUrl));
    res.cookies.delete(stateCookie("tiktok"));
    return res;
  };
  const p = req.nextUrl.searchParams;
  if (p.get("error")) return back(`error=${encodeURIComponent(p.get("error_description") ?? p.get("error")!)}`);
  if (!stateMatches(p.get("state"), req.cookies.get(stateCookie("tiktok"))?.value)) return back("error=Ugyldig%20OAuth-state%20(pr%C3%B8v%20igen)");
  try {
    const t = await exchangeCode(p.get("code") ?? "");
    await patchTikTokRuntime({ ownerActionReason: undefined, ownerActionAt: undefined });
    await record("info", "oauth", `TikTok forbundet (${t.accountName ?? t.accountId}), scopes: ${t.scopes.join(", ")}`);
    return back("ok=tiktok");
  } catch (err) {
    await record("error", "oauth", `TikTok OAuth fejlede: ${errMsg(err)}`);
    return back(`error=${encodeURIComponent(errMsg(err))}`);
  }
}
