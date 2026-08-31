import { sql, type User } from "../db/index.js";
import { runAgent } from "../agent/run.js";
import { canSendProactive, deliver, inQuietHours } from "../outbound/send.js";

type Due = { id: number; user_id: string; intent: string; source: string };

async function claimDue(): Promise<Due | null> {
  const [row] = await sql<Due[]>`
    update scheduled_messages set locked_at = now()
    where id = (
      select id from scheduled_messages
      where status = 'pending' and run_at <= now() and locked_at is null
      order by run_at
      for update skip locked
      limit 1
    )
    returning id, user_id, intent, source`;
  return row ?? null;
}

/** Push a follow-up to the next non-quiet hour instead of dropping it. */
function nextAllowedTime(user: User): Date {
  const next = new Date();
  for (let i = 0; i < 24; i++) {
    next.setTime(next.getTime() + 3600_000);
    if (!inQuietHours(user, next)) return next;
  }
  return next;
}

export async function processOneFollowup(): Promise<boolean> {
  const due = await claimDue();
  if (!due) return false;

  try {
    const [user] = await sql<User[]>`select * from users where id = ${due.user_id}`;
    if (!user) {
      await sql`update scheduled_messages set status = 'canceled' where id = ${due.id}`;
      return true;
    }

    if (inQuietHours(user)) {
      await sql`update scheduled_messages
                set run_at = ${nextAllowedTime(user)}, locked_at = null
                where id = ${due.id}`;
      return true;
    }

    if (!(await canSendProactive(user))) {
      await sql`update scheduled_messages set status = 'skipped' where id = ${due.id}`;
      return true;
    }

    const result = await runAgent(user, {
      trigger: due.source === "sweep" ? "sweep" : "followup",
      triggerIntent: due.intent,
    });

    if (result.quiet || !result.bubbles.length) {
      // Deciding not to text is a real outcome, not a failure. Restraint is
      // what keeps this welcome in someone's messages.
      await sql`update scheduled_messages set status = 'skipped' where id = ${due.id}`;
      return true;
    }

    await deliver(user, result.bubbles, { proactive: true });
    await sql`update scheduled_messages
              set status = 'sent', sent_at = now() where id = ${due.id}`;
  } catch (err) {
    console.error(`[followup] ${due.id}`, err);
    // Retry once in 15 minutes rather than losing the commitment entirely.
    await sql`update scheduled_messages
              set locked_at = null, run_at = now() + interval '15 minutes'
              where id = ${due.id}`;
  }
  return true;
}

export function startFollowupWorker(): void {
  const tick = async () => {
    try {
      while (await processOneFollowup());
    } catch (err) {
      console.error("[followup worker]", err);
    } finally {
      setTimeout(tick, 5000);
    }
  };
  void tick();
  console.log("[followup worker] running");
}
