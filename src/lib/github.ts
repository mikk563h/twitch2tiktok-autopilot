import { config } from "./config";
import { log } from "./log";

const api = (path: string) => `https://api.github.com/repos/${config.githubRepo}${path}`;
const headers = () => ({ Authorization: `Bearer ${config.githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });

export function githubConfigured() {
  return !!(config.githubRepo && config.githubToken);
}

/** Starts the autopilot workflow now (workflow_dispatch). Returns false if not configured or refused. */
export async function triggerWorkflow(): Promise<boolean> {
  if (!githubConfigured()) return false;
  try {
    const res = await fetch(api(`/actions/workflows/${config.githubWorkflow}/dispatches`), {
      method: "POST", headers: headers(), body: JSON.stringify({ ref: config.githubRef }), signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn({ status: res.status }, "GitHub workflow_dispatch afvist");
    return res.ok;
  } catch (err) {
    log.warn({ err }, "GitHub workflow_dispatch fejlede");
    return false;
  }
}

/** GitHub disables scheduled workflows in inactive repos; this re-enables it (idempotent). */
export async function ensureWorkflowEnabled(): Promise<{ ok: boolean; state?: string }> {
  if (!githubConfigured()) return { ok: false };
  const res = await fetch(api(`/actions/workflows/${config.githubWorkflow}`), { headers: headers(), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return { ok: false };
  const wf = (await res.json()) as { state: string };
  if (wf.state !== "active") {
    const en = await fetch(api(`/actions/workflows/${config.githubWorkflow}/enable`), { method: "PUT", headers: headers(), signal: AbortSignal.timeout(10_000) });
    return { ok: en.ok, state: en.ok ? "active (genaktiveret)" : wf.state };
  }
  return { ok: true, state: wf.state };
}

export interface WorkflowRun { status: string; conclusion: string | null; created_at: string; html_url: string; event: string }

export async function latestRuns(n = 5): Promise<WorkflowRun[]> {
  if (!githubConfigured()) return [];
  try {
    const res = await fetch(api(`/actions/workflows/${config.githubWorkflow}/runs?per_page=${n}`), { headers: headers(), signal: AbortSignal.timeout(10_000), next: { revalidate: 30 } } as RequestInit);
    if (!res.ok) return [];
    return ((await res.json()) as { workflow_runs: WorkflowRun[] }).workflow_runs;
  } catch {
    return [];
  }
}
