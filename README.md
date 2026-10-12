# Twitch2TikTok Autopilot

Fuldautomatisk system der overvåger **twitch.tv/sondergaardlol**, henter hvert nyt clip, lader AI se og høre det, redigerer det til en vertikal TikTok-video med undertekster, skriver en relevant dansk titel og uploader via TikToks officielle Content Posting API — 24/7 på en VPS, uden at din computer skal være tændt.

```
Twitch Helix ──► monitor-worker ──► PostgreSQL (sandhedskilde) ◄── dashboard (Next.js)
                     │                    ▲
                     ▼                    │
                Redis/BullMQ ──► render-worker  (download → bevægelsesanalyse → whisper → Claude → FFmpeg)
                     │
                     └────────► uploader-worker (TikTok Direct Post / inbox, statuspolling)
```

## Gratis opsætning: Vercel + GitHub Actions + Neon (0 kr./md.)

```
GitHub Actions (hvert 15. min) ──► scripts/run-once.ts: scan Twitch → download → whisper → (Claude) → FFmpeg → TikTok
            │                                  ▲
            ▼                                  │
      Neon Postgres (gratis) ◄──────── Vercel: dashboard, login, OAuth (gratis)
```

- **Uden Redis og faste workers.** Databasen er køen. Hver kørsel samler op, hvor den forrige slap, også efter nedbrud eller timeout. Beskyttelsen mod dobbeltpost er den samme.
- **To faser.** `plan` scanner og tjekker køen på ca. 1 minut. Kun hvis der er arbejde, installeres FFmpeg og whisper (cachet), og `work` kører.
- **Ingen faste videofiler.** Runneren slettes efter hver kørsel. Hvis upload sker senere, genskabes videoen automatisk uden en ny AI-analyse.
- **Kør nu.** Knappen i dashboardet starter workflowet med det samme (kræver `GITHUB_TOKEN` i Vercel). Et dagligt Vercel-cron sikrer, at GitHub-planen ikke bliver slået fra.
- **Uden `ANTHROPIC_API_KEY`** bruges Twitch-titlen. Et Claude Pro/Max-abonnement dækker ikke API-kald fra et program.

**Miljøvariabler.** `DATABASE_URL` og `APP_ENCRYPTION_KEY` skal være **ens** begge steder.

| Hvor | Værdier |
|---|---|
| **Vercel** (Project → Settings → Environment Variables) | `DATABASE_URL`, `APP_URL` (fx `https://xxx.vercel.app`), `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD_HASH`, `TWITCH_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET`, `GITHUB_REPO` (`bruger/repo`), `GITHUB_TOKEN` (fine-grained, *Actions: read & write* på repoet), `CRON_SECRET`, `DB_POOL_MAX=1` |
| **GitHub** (Settings → Secrets and variables → Actions) | Secrets: `DATABASE_URL`, `APP_ENCRYPTION_KEY`, `TWITCH_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET`, valgfrit `ANTHROPIC_API_KEY`, `SMTP_URL`, `ALERT_EMAIL_TO`, `HEARTBEAT_URL`. Variables: `APP_URL`, valgfrit `WHISPER_MODEL` |

**Gratis kvoter.** Neon giver 0,5 GB og 100 CU-timer om måneden; sæt compute til 0,25 CU, og en kørsel hvert 15. minut bruger ca. 70. GitHub Actions er ubegrænset for offentlige repos. Vercel Hobby er gratis.

Server-opsætningen nedenfor (Docker på en VPS) virker stadig. Den aktiveres automatisk, når `REDIS_URL` er sat.

## Indhold

- [Hvad systemet gør](#hvad-systemet-gør)
- [Vigtigt om rettigheder og TikTok-godkendelse](#vigtigt-om-rettigheder-og-tiktok-godkendelse)
- [Installation på VPS](#installation-på-vps)
- [Opsætning af Twitch, TikTok og AI](#opsætning-af-twitch-tiktok-og-ai)
- [Drift: opdatering, rollback, backup, overvågning](#drift)
- [Clip-statusser](#clip-statusser)
- [Tests](#tests)
- [Omkostninger](#omkostninger)
- [Fejlfinding](#fejlfinding)

## Hvad systemet gør

| Del | Detaljer |
|---|---|
| **Overvågning** | Twitch *Get Clips* hvert 60. sek (justerbart). Twitch sorterer efter visninger, så der scannes i **datovinduer med fuld pagination**; vinduer med ≥900 clips splittes. 30 min **overlap** fanger clips Twitch indekserer sent, og en **dyb scanning** af de sidste 72 t kører hver 6. time. Efter nedetid scannes automatisk hele perioden siden sidste succes (**backfill**). Clip-ID er unikt i databasen — dobbeltregistrering er umulig. |
| **Baseline** | Ved første start registreres eksisterende clips som `BASELINE` og uploades **ikke**. *Automation → Historisk import* sætter en periode i kø. |
| **Download** | Officielt *Get Clips Download* API når en broadcaster-/editor-konto er forbundet (scope `editor:manage:clips`/`channel:manage:clips`). Ellers hentes den offentlige clip-fil (yt-dlp). Indstillingen *Kun officiel* gør manglende rettighed til en tydelig `BLOCKED_PERMISSION`. |
| **Analyse** | Lokal bevægelsesanalyse (hvor handlingen er), **whisper.cpp** transskription (dansk/engelsk, ord-tidskoder), og **Claude** (vision) ser 8 frames + transskription + Twitch-titel. |
| **Titel** | Kort dansk titel baseret kun på det der ses/høres. Valideres mod forbudte/generiske titler og gentagelser, **faktatjekkes** i et separat AI-kald, og ved usikkerhed/fejl bruges **den originale Twitch-titel**. Mangler begge → fejlkø. Aldrig en hardcoded titel. |
| **Editor** | FFmpeg: 1080×1920, H.264/AAC MP4, 30/60 fps efter kilde. Layouts: *sløret baggrund* (standard, bevarer hele gameplayet), *smart crop*, *split facecam/gameplay* (AI-detekteret eller manuel position). TikTok-undertekster med fremhævet ord. 2-pass loudness-normalisering + limiter. Ingen musik tilføjes. |
| **Hashtags** | Faste hashtags (prioriteret rækkefølge) + valgfri AI-hashtags fra det faktiske klip, dubletter fjernes, maks antal, caption ≤ 2200 tegn. |
| **TikTok** | OAuth med automatisk token-refresh, creator info, Direct Post (FILE_UPLOAD, chunks), statuspolling, rate limits, inbox-/manuel tilstand. |
| **Sikkerhed mod dobbeltpost** | Højst ét aktivt upload-forsøg pr. clip (unikt DB-index), idempotency key pr. forsøg, `publish_id` gemmes **før** der sendes data, og ved uklar status **spørges TikTok** — der uploades aldrig blindt igen. |
| **Selvhelbredelse** | Docker restart-policies + health checks + autoheal, heartbeats, reconciler der genopretter jobs ud fra databasen hvert minut (også hvis Redis mistes), eksponentiel backoff med jitter, e-mail-alarmer, ekstern heartbeat, natlig backup + ugentlig automatisk restore-test, oprydning af filer, disk-/CPU-/RAM-overvågning. |

## Vigtigt om rettigheder og TikTok-godkendelse

1. **Rettigheder.** Systemet kan teknisk hente offentlige clips, men du må kun genudgive dem, hvis rettighedshaveren (SondergaardLOL) har givet tilladelse. Setup Wizard kræver en eksplicit bekræftelse, før automatisk publicering kan slås til.
2. **TikTok audit.** En TikTok-app der ikke er auditeret kan **kun poste privat (SELF_ONLY)** — det virker med det samme, og systemet kan derfor testes fuldt. Offentlig auto-publicering kræver at TikTok godkender appen. TikToks retningslinjer nævner *"en app der kopierer vilkårligt indhold fra andre platforme til TikTok"* som uacceptabel; ansøg derfor som den officielle kanal/med dokumenteret tilladelse. Systemet omgår ikke disse regler — hvis godkendelse mangler, klargøres videoerne fuldt og dashboardet viser præcis hvad der mangler. Alternativ: *inbox-tilstand* (videoen lander som udkast i TikTok-appen, og du trykker publicér).
3. Dashboardet markerer først *"Offentlig automatisk publicering godkendt"*, når en offentlig post faktisk er verificeret af TikTok.

## Installation på VPS

**Anbefalet:** Hetzner Cloud **CX33** (4 vCPU, 8 GB RAM, 80 GB SSD), Ubuntu 24.04, placering Falkenstein/Nürnberg/Helsinki. Det er rigeligt til FFmpeg + whisper `small` på 30–60 sek clips (ca. 1–2 min CPU pr. clip). Vil du bruge whisper `medium` for bedre dansk, vælg 8 vCPU (CX43).

1. Opret serveren med din SSH-nøgle, og peg et domæne (A-record) på dens IP, fx `t2t.ditdomæne.dk`.
2. På serveren:
   ```bash
   ssh root@SERVER_IP
   git clone <dette-repo> /opt/t2t && cd /opt/t2t
   ./scripts/server-setup.sh        # Docker, firewall, swap, automatiske sikkerhedsopdateringer
   ./scripts/gen-secrets.sh         # genererer hemmeligheder + dashboard-adgangskode i .env
   nano .env                        # DOMAIN, APP_URL, ACME_EMAIL, nøgler (se nedenfor)
   ./scripts/deploy.sh              # bygger, migrerer, starter og health-checker
   ```
3. Åbn **https://DIT-DOMÆNE** → log ind → **Setup Wizard** fører dig gennem resten.

Alt starter automatisk efter genstart af serveren (`restart: unless-stopped`).

## Opsætning af Twitch, TikTok og AI

**Twitch** — <https://dev.twitch.tv/console/apps> → *Register Your Application* (Confidential). OAuth Redirect URL: `https://DIT-DOMÆNE/api/oauth/twitch/callback`. Sæt `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`. Valgfrit (anbefalet): *Accounts → Forbind som editor/broadcaster* for officiel download. En editor-konto skal være tilføjet af kanalejeren under *Creator Dashboard → Settings → Roles*.

**TikTok** — <https://developers.tiktok.com/apps> → opret app → tilføj **Login Kit** (Web, redirect `https://DIT-DOMÆNE/api/oauth/tiktok/callback`, verificér domænet) og **Content Posting API** med **Direct Post** slået til. Scopes: `user.info.basic`, `video.publish`, `video.upload`. I sandbox: tilføj din TikTok-konto som target user. Sæt `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`, forbind under *Accounts*, vælg synlighed (ingen standard — TikTok kræver at du vælger), interaktioner og giv samtykke. Ansøg om audit for offentlige posts.

**AI** — <https://console.anthropic.com/settings/keys> → `ANTHROPIC_API_KEY`. Model `claude-opus-5-5` (kan ændres med `AI_MODEL`). Transskription kører lokalt (whisper.cpp) — ingen OpenAI-nøgle nødvendig. Modellen hentes automatisk første gang (~466 MB for `small`).

**Notifikationer** — `SMTP_URL` + `ALERT_EMAIL_TO` for e-mail. `HEARTBEAT_URL` til fx [healthchecks.io](https://healthchecks.io) (gratis): monitor-workeren pinger hvert minut når alt er OK og `/fail` ved kritiske problemer; healthchecks.io mailer dig hvis pings udebliver (fx hvis hele serveren er nede). Ekstern uptime-check kan også pege på `https://DIT-DOMÆNE/api/health?deep=1` (503 hvis en worker er nede).

## Drift

| Opgave | Kommando |
|---|---|
| Opdatér til ny version | `git pull && ./scripts/deploy.sh` (backup → build `t2t-app:<commit>` → migrér → start → health check → **automatisk rollback** ved fejl) |
| Rul tilbage | `./scripts/rollback.sh` (eller `./scripts/rollback.sh <tag>`; se `docker images t2t-app`) |
| Status | `docker compose ps` |
| Logs | `docker compose logs -f render uploader monitor` (roteres: 5×10 MB pr. container) |
| Backup nu | `./scripts/backup-now.sh` → `./backups/` (natlig backup kl. 03:30 UTC, 14 dages opbevaring) |
| Restore-test | `./scripts/restore-test.sh` (gendanner seneste backup i en midlertidig DB; kører også automatisk hver søndag) |
| Gendan | `./scripts/restore.sh backups/t2t-XXXX.dump` |
| Offsite backup | Kopiér `./backups` til fx en Hetzner Storage Box (`rclone`/`rsync` i cron) — anbefalet |

Koden ændrer aldrig sig selv; opdateringer sker kun via `deploy.sh` med tests, tagget image og rollback.

## Clip-statusser

`BASELINE` (historisk, ikke i kø) → `DISCOVERED` → `QUEUED` → `DOWNLOADING` → `DOWNLOADED` → `ANALYZING` → `EDITING` → `READY` → `UPLOADING` → `PROCESSING` → `PUBLISHED`

Sidespor: `RETRY_WAIT` (venter på automatisk retry med backoff), `BLOCKED_PERMISSION` (mangler rettighed/forbindelse — genoptages automatisk når det er rettet), `NEEDS_USER_ACTION` (fx inbox-udkast eller uafklaret TikTok-status — afgøres med knapperne *Er publiceret / Ikke publiceret*), `FAILED` (efter 8 forsøg eller permanent fejl — manuel retry i dashboardet).

Hvis TikTok begrænser antallet af posts, bliver clips stående som `READY` med næste tidspunkt — intet slettes.

## Tests

```bash
npm install
npm test            # 80 tests: rigtig Postgres + Redis (embedded), rigtig FFmpeg og whisper.cpp
```

Testene bruger **mock-servere** for Twitch, TikTok og Claude (`tests/mocks/server.ts`, tydeligt markeret). En bestået mocked upload beviser **ikke** at TikTok har modtaget en video. End-to-end-testen (`tests/pipeline.test.ts`) starter de rigtige worker-processer, dræber render-workeren med `kill -9` midt i arbejdet og verificerer at en ny worker færdiggør uden dobbeltpost; en anden test simulerer servergenstart med tabt Redis.

Rigtig test mod de ægte API'er (når nøgler og konti findes):

```bash
docker compose exec web node --import tsx scripts/live-e2e.ts            # Twitch, download, FFmpeg, whisper, Claude, TikTok creator info
docker compose exec web node --import tsx scripts/live-e2e.ts --upload   # + én PRIVAT (SELF_ONLY) testupload til TikTok
```

Krav til whisper/FFmpeg lokalt (macOS): `ffmpeg`, `whisper-cli` (whisper.cpp) og `WHISPER_BIN`/`WHISPER_MODEL` sat — ellers springes STT-testen over.

## Omkostninger

Overslag pr. måned (priser oktober 2026, ekskl. moms — tjek aktuelle priser):

| Post | Pris |
|---|---|
| Hetzner CX33 (4 vCPU / 8 GB / 80 GB) + IPv4 | ca. €7–10 |
| Backups af serveren (Hetzner, +20 %) — valgfrit | ca. €1,5–2 |
| Hetzner Storage Box 1 TB (offsite DB-backup) — valgfrit | ca. €4 |
| Domæne | ca. €1 |
| Claude (`claude-opus-5-5`, $4/$20 pr. mio. tokens): ~8 frames + transskription ≈ 4–6k input + ~1–2k output (inkl. faktatjek) ≈ **$0,03–0,06 pr. clip** | 10 clips/dag ≈ **$10–18**; 30/dag ≈ $30–55 |
| Whisper, FFmpeg, Postgres, Redis, Caddy/HTTPS | 0 (kører på serveren) |
| **Typisk total** (10 clips/dag) | **ca. €20–35 / md.** |

Billigere AI: sæt `AI_MODEL=claude-sonnet-5-5` ($2/$10) for ca. halv pris, eller sænk *Frames pr. clip* i Video Editor.

## Fejlfinding

| Symptom | Løsning |
|---|---|
| Wizard trin 1 rødt | `docker compose ps` — er alle `healthy`? `docker compose logs <service>` |
| Clips står i `BLOCKED_PERMISSION` | Se årsagen i Upload Queue (manglende samtykke, TikTok-scope, Twitch-editor). Genoptages automatisk når det er rettet. |
| `unaudited_client_can_only_post_to_private_accounts` | Appen er ikke auditeret — vælg "Kun mig" eller afvent TikToks audit. |
| `spam_risk_too_many_posts` | TikToks daglige grænse; clips venter i køen. Sænk *Maks posts pr. 24 t*. |
| Undertekster forkerte på dansk | `WHISPER_MODEL=medium` (kræver mere CPU), eller slå undertekster fra. |
| Disk fyldes | Sænk retention under *Automation → Avanceret*; publicerede filer slettes automatisk. |
