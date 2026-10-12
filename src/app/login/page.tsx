export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,#8b5cf622,transparent_60%)]" />
      <form action="/api/login" method="post" className="card card-pad relative w-full max-w-sm space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent font-bold text-white">T2</div>
          <div>
            <h1 className="text-lg font-semibold">Twitch2TikTok</h1>
            <p className="text-sm text-muted">Log ind på dashboardet</p>
          </div>
        </div>
        <input type="hidden" name="next" value={next ?? "/"} />
        <div>
          <label className="label" htmlFor="password">Adgangskode</label>
          <input id="password" name="password" type="password" required autoFocus className="input" autoComplete="current-password" />
        </div>
        {error && (
          <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">
            {error === "locked" ? "For mange forsøg. Vent 15 minutter." : "Forkert adgangskode."}
          </p>
        )}
        <button className="btn-primary w-full">Log ind</button>
      </form>
    </main>
  );
}
