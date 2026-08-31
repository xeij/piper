import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { sql, type User } from "./db/index.js";
import { runAgent } from "./agent/run.js";
import { refreshStyleProfile } from "./agent/style.js";
import { regenerateProfile } from "./memory/profile.js";
import { advanceStage } from "./onboarding.js";
import { splitBubbles } from "./agent/run.js";

/**
 * Terminal harness for the part that actually decides whether this product
 * works: the voice. Runs the real prompt, memory, and tools against the real
 * database — only the SMS transport is stubbed. Use this before you ever pay
 * for a phone number.
 *
 *   npm run sim -- +15550001111
 */
const phone = process.argv[2] ?? "+15550000000";

let [user] = await sql<User[]>`select * from users where phone = ${phone}`;
if (!user) {
  [user] = await sql<User[]>`
    insert into users (phone, channel, onboarding_stage)
    values (${phone}, 'imessage', 'new') returning *`;
  console.log(`created sim user ${phone}`);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
console.log(`\npiper sim — ${phone} (stage: ${user!.onboarding_stage})`);
console.log(`commands: /state  /reset  /followup <intent>  /quit\n`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reload(): Promise<User> {
  const [u] = await sql<User[]>`select * from users where id = ${user!.id}`;
  return u!;
}

async function say(trigger: "inbound" | "followup", intent?: string) {
  const u = await reload();
  const started = Date.now();
  const result = await runAgent(u, { trigger, triggerIntent: intent });

  if (result.quiet || !result.bubbles.length) {
    console.log(`\x1b[90m  (piper chose to stay quiet)\x1b[0m`);
  }
  for (const b of result.bubbles) {
    await sleep(Math.min(1200, b.length * 20));
    console.log(`\x1b[36m  ${b}\x1b[0m`);
    await sql`insert into messages (user_id, direction, body)
              values (${u.id}, 'out', ${b})`;
  }

  const cachePct = result.usage.input + result.usage.cacheRead > 0
    ? Math.round((result.usage.cacheRead / (result.usage.input + result.usage.cacheRead)) * 100)
    : 0;
  console.log(
    `\x1b[90m  [${Date.now() - started}ms · in ${result.usage.input} · cached ${result.usage.cacheRead} (${cachePct}%) · out ${result.usage.output}]\x1b[0m`,
  );
}

for (;;) {
  const line = (await rl.question("\x1b[32myou> \x1b[0m")).trim();
  if (!line) continue;

  if (line === "/quit") break;

  if (line === "/state") {
    const u = await reload();
    const goals = await sql`select id, title, status, last_progress_at from goals where user_id = ${u.id}`;
    const facts = await sql`select kind, key, value from facts where user_id = ${u.id}`;
    const sched = await sql`select run_at, intent, status from scheduled_messages where user_id = ${u.id} order by run_at`;
    console.log({
      stage: u.onboarding_stage,
      subscription: u.subscription_status,
      style: u.style_profile,
      dossier: u.profile_doc || "(empty)",
      goals, facts, scheduled: sched,
    });
    continue;
  }

  if (line === "/reset") {
    await sql`delete from users where id = ${user!.id}`;
    [user] = await sql<User[]>`
      insert into users (phone, channel, onboarding_stage)
      values (${phone}, 'imessage', 'new') returning *`;
    console.log("reset");
    continue;
  }

  if (line.startsWith("/followup")) {
    await say("followup", line.slice("/followup".length).trim() || "check in on their goal");
    continue;
  }

  const u = await reload();
  await sql`insert into messages (user_id, direction, body) values (${u.id}, 'in', ${line})`;
  await sql`update users set last_inbound_at = now() where id = ${u.id}`;
  await advanceStage(u);
  await say("inbound");

  await refreshStyleProfile(u.id);
  const fresh = await reload();
  if (!fresh.profile_doc_at || Date.now() - fresh.profile_doc_at.getTime() > 600_000) {
    await regenerateProfile(u.id);
  }
}

rl.close();
await sql.end();
