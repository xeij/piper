import crypto from "node:crypto";
import { config } from "../config.js";

// Apple Calendar has no OAuth API, so Piper publishes a per-user .ics feed the
// user subscribes to once. The URL is the credential: uid plus an HMAC that
// never expires, so the subscription keeps working.

function mac(uid: string): string {
  return crypto.createHmac("sha256", config.linkSigningSecret).update(`ical:${uid}`).digest("base64url");
}

export function feedToken(uid: string): string {
  return `${uid}.${mac(uid)}`;
}

export function verifyFeedToken(token: string): string | null {
  const [uid, given] = token.split(".");
  if (!uid || !given) return null;
  const expected = mac(uid);
  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? uid : null;
}

export function feedUrl(uid: string): string {
  return `${config.publicBaseUrl.replace(/^https?:/, "webcal:")}/cal/${feedToken(uid)}.ics`;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");

export function renderIcs(
  events: { id: number; title: string; notes: string | null; starts_at: Date; ends_at: Date; created_at: Date }[],
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//piper//calendar//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:piper",
    // Hint to clients to re-fetch often; Apple treats this as a minimum, not a promise.
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:piper-${e.id}@piper`,
      `DTSTAMP:${stamp(e.created_at)}`,
      `DTSTART:${stamp(e.starts_at)}`,
      `DTEND:${stamp(e.ends_at)}`,
      `SUMMARY:${esc(e.title)}`,
      ...(e.notes ? [`DESCRIPTION:${esc(e.notes)}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
