import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "./auth";

/** Defense in depth for server actions and route handlers (the proxy already gates pages). */
export async function requireSession() {
  const store = await cookies();
  if (!(await verifySessionToken(store.get(SESSION_COOKIE)?.value))) throw new Error("Ikke logget ind");
}
