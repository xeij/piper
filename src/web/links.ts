import crypto from "node:crypto";
import { config } from "../config.js";

// Short-lived signed magic links. OAuth and checkout can't happen inside a
// text thread, so the agent hands out a URL that proves who the user is
// without them logging into anything.
type Payload = { uid: string; kind: "calendar" | "checkout"; exp: number };

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(data: string): string {
  return crypto
    .createHmac("sha256", config.linkSigningSecret)
    .update(data)
    .digest("base64url");
}

export function createLink(
  uid: string,
  kind: Payload["kind"],
  ttlMinutes = 60,
): string {
  const payload: Payload = {
    uid,
    kind,
    exp: Date.now() + ttlMinutes * 60_000,
  };
  const body = b64url(JSON.stringify(payload));
  const token = `${body}.${sign(body)}`;
  const path = kind === "calendar" ? "/connect/google" : "/subscribe";
  return `${config.publicBaseUrl}${path}?t=${token}`;
}

export function verifyLink(token: string): Payload | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = sign(body);
  // Length check first — timingSafeEqual throws on mismatched lengths.
  if (
    mac.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Payload;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
