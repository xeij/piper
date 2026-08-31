import { config } from "../config.js";
import type { Channel, InboundMessage } from "./types.js";

// iMessage relay. Blue bubbles, typing indicators, tapbacks.
// NOTE: relays operate against Apple's ToS — numbers can be burned with no
// notice. Everything here sits behind the Channel interface precisely so
// `CHANNEL_PROVIDER=twilio` is a one-line migration of the whole user base.
const BASE = "https://api.sendblue.co/api";

function headers() {
  return {
    "sb-api-key-id": config.channel.sendblue.apiKey,
    "sb-api-secret-key": config.channel.sendblue.apiSecret,
    "content-type": "application/json",
  };
}

export const sendblueChannel: Channel = {
  kind: "imessage",
  supportsTyping: true,

  async send(to, body) {
    const res = await fetch(`${BASE}/send-message`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        number: to,
        content: body,
        from_number: config.channel.sendblue.from || undefined,
      }),
    });
    if (!res.ok) {
      throw new Error(`sendblue send failed ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { message_handle?: string };
    return { providerId: json.message_handle ?? `sb_${Date.now()}` };
  },

  async sendTyping(to) {
    // Best-effort: a failed typing indicator must never block the reply.
    try {
      await fetch(`${BASE}/send-typing-indicator`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ number: to }),
      });
    } catch {
      /* ignore */
    }
  },

  parseWebhook(payload) {
    const p = payload as Record<string, unknown>;
    if (p?.["is_outbound"] === true) return null;
    const from = p?.["from_number"] ?? p?.["number"];
    const content = p?.["content"];
    if (typeof from !== "string" || typeof content !== "string") return null;
    if (!content.trim()) return null;
    return {
      from,
      body: content,
      providerId: String(p?.["message_handle"] ?? `sb_in_${from}_${Date.now()}`),
      kind: "imessage",
    } satisfies InboundMessage;
  },
};
