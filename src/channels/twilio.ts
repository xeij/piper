import { config } from "../config.js";
import type { Channel, InboundMessage } from "./types.js";

// SMS fallback. Boring, legal, scales forever, ~1/3 the per-message cost of a
// relay. Requires A2P 10DLC registration before it will deliver reliably.
export const twilioChannel: Channel = {
  kind: "sms",
  supportsTyping: false,

  async send(to, body) {
    const { accountSid, authToken, from } = config.channel.twilio;
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization:
            "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
      },
    );
    if (!res.ok) {
      throw new Error(`twilio send failed ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { sid?: string };
    return { providerId: json.sid ?? `tw_${Date.now()}` };
  },

  parseWebhook(payload) {
    const p = payload as Record<string, unknown>;
    const from = p?.["From"];
    const body = p?.["Body"];
    if (typeof from !== "string" || typeof body !== "string") return null;
    if (!body.trim()) return null;
    return {
      from,
      body,
      providerId: String(p?.["MessageSid"] ?? `tw_in_${from}_${Date.now()}`),
      kind: "sms",
    } satisfies InboundMessage;
  },
};
