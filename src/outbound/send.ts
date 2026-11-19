import { config } from "../config.js";
import { channel } from "../channels/index.js";
import { sql, type User } from "../db/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Roughly how long a person takes to thumb out a message of this length. */
function typingDelayMs(text: string): number {
  return Math.min(4000, Math.max(900, text.length * 45));
}

export function localHour(user: User, at = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: user.timezone,
      hour: "numeric",
      hour12: false,
    }).format(at),
  ) % 24;
}

export function inQuietHours(user: User, at = new Date()): boolean {
  const h = localHour(user, at);
  const { quiet_hours_start: start, quiet_hours_end: end } = user;
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/**
 * Proactive sends are budgeted; replies never are. The budget exists for two
 * reasons and they point the same way: every bubble costs real money to
 * deliver, and a bot that texts you six times a day gets blocked.
 */
export async function canSendProactive(user: User): Promise<boolean> {
  if (user.opted_out) return false;
  if (user.onboarding_stage === "paywalled") return false;
  if (inQuietHours(user)) return false;
  const today = new Date().toISOString().slice(0, 10);
  const used = user.budget_day === today ? user.proactive_sent_today : 0;
  return used < config.limits.maxProactivePerDay;
}

export async function deliver(
  user: User,
  bubbles: string[],
  opts: { proactive: boolean },
): Promise<void> {
  if (!bubbles.length) return;
  if (user.opted_out) return;

  for (const [i, bubble] of bubbles.entries()) {
    if (channel.supportsTyping && channel.sendTyping) {
      await channel.sendTyping(user.phone);
    }
    // Never instant. An instant reply to a paragraph is as robotic as a
    // three-second reply to "hey" is uncanny.
    await sleep(typingDelayMs(bubble) + (i > 0 ? 400 : 0));

    const { providerId } = await channel.send(user.phone, bubble);
    await sql`
      insert into messages (user_id, direction, body, provider_id, proactive)
      values (${user.id}, 'out', ${bubble}, ${providerId}, ${opts.proactive})`;
  }

  const today = new Date().toISOString().slice(0, 10);
  await sql`
    update users set
      last_outbound_at = now(),
      budget_day = ${today},
      proactive_sent_today = case
        when budget_day = ${today} then proactive_sent_today + ${opts.proactive ? bubbles.length : 0}
        else ${opts.proactive ? bubbles.length : 0}
      end
    where id = ${user.id}`;
}
