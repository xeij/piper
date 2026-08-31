import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { sql, type User } from "../db/index.js";
import { canSendProactive } from "../outbound/send.js";

const client = new Anthropic();

const SWEEP_PROMPT = `
You decide whether a texting companion should reach out to someone today, based
only on their state below.

Reach out only when there is a specific, real reason: something they committed
to and a check would land, a goal that has visibly stalled, something they said
was happening around now, or a genuine gap since you last spoke.

Do NOT reach out to say hi, to be encouraging in general, to "check in", or
because it has been a while and that feels like enough. Someone who texts
without a reason gets muted. The default answer is no.

Respond with exactly one line:
NO
or
YES: <one sentence naming the specific reason, written for yourself to read later>
`.trim();

type Candidate = User & { stalled: string | null; days_since: number | null };

/**
 * Cheap gate, expensive write. Haiku decides IF we text; only then does the
 * full Sonnet agent get invoked to decide WHAT to say. Running the real agent
 * across the whole user base nightly would cost more than the subscription.
 */
export async function runNightlySweep(): Promise<void> {
  const candidates = await sql<Candidate[]>`
    select u.*,
      (select string_agg(g.title || ' (' ||
          coalesce(extract(day from now() - g.last_progress_at)::int::text, 'never') ||
          ' days since progress)', '; ')
       from goals g
       where g.user_id = u.id and g.status = 'active'
         and (g.last_progress_at is null or g.last_progress_at < now() - interval '3 days')
      ) as stalled,
      extract(day from now() - u.last_inbound_at)::int as days_since
    from users u
    where u.opted_out = false
      and u.onboarding_stage <> 'new'
      and (u.last_outbound_at is null or u.last_outbound_at < now() - interval '20 hours')
      and exists (select 1 from goals g where g.user_id = u.id and g.status = 'active')
      -- don't pile a sweep on top of a follow-up the agent already scheduled
      and not exists (
        select 1 from scheduled_messages s
        where s.user_id = u.id and s.status = 'pending'
          and s.run_at < now() + interval '24 hours'
      )`;

  for (const user of candidates) {
    try {
      if (!(await canSendProactive(user))) continue;

      const state = [
        `Dossier: ${user.profile_doc || "(none yet)"}`,
        `Stalled goals: ${user.stalled ?? "none"}`,
        `Days since they last texted: ${user.days_since ?? "unknown"}`,
        `Onboarding stage: ${user.onboarding_stage}`,
      ].join("\n");

      const response = await client.messages.create({
        model: config.models.background,
        max_tokens: 200,
        system: SWEEP_PROMPT,
        messages: [{ role: "user", content: state }],
      });

      const line = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();

      if (!line.toUpperCase().startsWith("YES")) continue;

      const intent = line.slice(line.indexOf(":") + 1).trim();
      if (!intent) continue;

      // Land it at a plausible hour rather than the instant the cron fired.
      const runAt = new Date(Date.now() + (2 + Math.random() * 6) * 3600_000);
      await sql`
        insert into scheduled_messages (user_id, run_at, intent, source)
        values (${user.id}, ${runAt}, ${intent}, 'sweep')`;
    } catch (err) {
      console.error(`[sweep] ${user.id}`, err);
    }
  }
}

export function startSweepWorker(): void {
  const HOUR = 3600_000;
  const tick = async () => {
    try {
      await runNightlySweep();
    } catch (err) {
      console.error("[sweep worker]", err);
    } finally {
      setTimeout(tick, 6 * HOUR);
    }
  };
  setTimeout(tick, 30_000);
  console.log("[sweep worker] running");
}
