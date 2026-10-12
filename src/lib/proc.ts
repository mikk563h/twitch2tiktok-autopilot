import { spawn } from "node:child_process";

export class ProcError extends Error {
  constructor(message: string, public code: number | null, public stderr: string) {
    super(message);
  }
}

export interface RunResult { stdout: Buffer; stderr: string }

/** Spawns a process with a hard timeout. stderr is kept (tail) for error messages. */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string; input?: Buffer; maxStdout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 10 * 60_000);
    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen <= (opts.maxStdout ?? 512 * 1024 * 1024)) out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 64_000) err = err.slice(-32_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ProcError(`${cmd} kunne ikke startes: ${e.message}`, null, err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new ProcError(`${cmd} timeout efter ${opts.timeoutMs ?? 600000} ms`, code, err));
      if (code !== 0) return reject(new ProcError(`${cmd} fejlede (exit ${code}): ${err.trim().split("\n").slice(-3).join(" | ")}`, code, err));
      resolve({ stdout: Buffer.concat(out), stderr: err });
    });
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
