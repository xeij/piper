import { config } from "./config.js";
import { sql, type User } from "./db/index.js";
import type { InboundMessage } from "./channels/index.js";
import { channel } from "./channels/index.js";
import { advanceStage } from "./onboarding.js";

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);
const HELP_WORDS = new Set(["help", "info"]);

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

async function alreadyProcessed(providerId: string): Promise<boolean> {
  const rows = await sql`
    insert into processed_events (id) values (${providerId})
    on conflict (id) do nothing returning id`;
  return rows.length === 0;
}

async function findOrCreate(msg: InboundMessage): Promise<User> {
  const phone = normalizePhone(msg.from);
  const [existing] = await sql<User[]>`select * from users where phone = ${phone}`;
  if (existing) return existing;

  const [created] = await sql<User[]>`
    insert into users (phone, channel) values (${phone}, ${msg.kind}) returning *`;
  return created!;
}

/**
 * Webhook path. Does the minimum synchronously and hands off to the debounced
 * turn worker — the provider wants a fast 200, and we want to wait out the
 * rest of the user's burst before generating anything.
 */
export async function handleInbound(msg: InboundMessage): Promise<void> {
  if (await alreadyProcessed(msg.providerId)) return;

  const user = await findOrCreate(msg);
  const body = msg.body.trim();
  const word = body.toLowerCase().replace(/[^a-z]/g, "");

  await sql`
    insert into messages (user_id, direction, body, provider_id)
    values (${user.id}, 'in', ${body}, ${msg.providerId})`;
  await sql`update users set last_inbound_at = now() where id = ${user.id}`;

  // Carrier-mandated keywords are handled in code, never by the model.
  if (STOP_WORDS.has(word)) {
    await sql`update users set opted_out = true, pending_turn_at = null where id = ${user.id}`;
    await sql`update scheduled_messages set status = 'canceled'
              where user_id = ${user.id} and status = 'pending'`;
    await channel.send(user.phone, "you're unsubscribed. i won't text again. reply START if you change your mind.");
    return;
  }
  if (START_WORDS.has(word) && user.opted_out) {
    await sql`update users set opted_out = false where id = ${user.id}`;
    await channel.send(user.phone, "you're back in. what's going on?");
    return;
  }
  if (HELP_WORDS.has(word)) {
    await channel.send(
      user.phone,
      "piper, an ai that helps you stay on your goals over text. reply STOP to opt out. support@piper.app",
    );
    return;
  }
  if (user.opted_out) return;

  // The first inbound message IS the signup event — a message the user sent
  // themselves, which is also the cleanest possible TCPA consent record. We
  // don't require the exact activation phrase to proceed; someone who typed it
  // slightly wrong should never dead-end.
  await advanceStage(user);

  // Each inbound pushes the deadline out, so a burst becomes one turn.
  await sql`
    update users set
      pending_turn_at = now() + ${config.limits.debounceMs} * interval '1 millisecond'
    where id = ${user.id}`;
}
