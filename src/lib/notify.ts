import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config";
import { log } from "./log";

let transport: Transporter | null = null;

export function emailConfigured(): boolean {
  return !!(config.smtpUrl && config.alertEmailTo);
}

/** Sends an alert e-mail. Returns false (never throws) when SMTP isn't configured or fails. */
export async function sendEmail(subject: string, text: string): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    transport ??= nodemailer.createTransport(config.smtpUrl!);
    await transport.sendMail({ from: config.alertEmailFrom, to: config.alertEmailTo, subject: `[Twitch2TikTok] ${subject}`, text });
    return true;
  } catch (err) {
    log.error({ err }, "E-mail kunne ikke sendes");
    return false;
  }
}

/** Pings an external heartbeat monitor (e.g. healthchecks.io). `/fail` signals a known problem. */
export async function pingHeartbeat(ok: boolean, message: string): Promise<boolean> {
  const url = config.heartbeatUrl;
  if (!url) return false;
  try {
    const res = await fetch(ok ? url : `${url.replace(/\/$/, "")}/fail`, { method: "POST", body: message.slice(0, 10_000), signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch (err) {
    log.warn({ err }, "Heartbeat-ping fejlede");
    return false;
  }
}
