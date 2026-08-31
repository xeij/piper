import { config } from "../config.js";
import { sql, type User } from "../db/index.js";
import { runAgent } from "../agent/run.js";
import { deliver } from "../outbound/send.js";
import { refreshStyleProfile } from "../agent/style.js";
import { regenerateProfile } from "../memory/profile.js";

/**
 * Inbound debounce. People text in bursts — "hey" / "so" / "i was thinking" —
 * and replying to the first fragment is the single most obvious bot tell.
 * Each inbound pushes `pending_turn_at` forward; we only run once the burst
 * has actually stopped.
 *
 * Postgres-only on purpose: SKIP LOCKED gives correct claim semantics across
 * multiple workers without adding Redis to the deploy.
 */
async function claimDueTurn(): Promise<User | null> {
  const [user] = await sql<User[]>`
    update users set turn_locked_at = now(), pending_turn_at = null
    where id = (
      select id from users
      where pending_turn_at is not null
        and pending_turn_at <= now()
        and opted_out = false
      order by pending_turn_at
      for update skip locked
      limit 1
    )
    returning *`;
  return user ?? null;
}

export async function processOneTurn(): Promise<boolean> {
  const user = await claimDueTurn();
  if (!user) return false;

  try {
    const result = await runAgent(user, { trigger: "inbound" });
    // The product promise is that it always replies to a real message.
    const bubbles = result.bubbles.length
      ? result.bubbles
      : ["hm, my brain glitched. say that again?"];
    await deliver(user, bubbles, { proactive: false });
  } catch (err) {
    console.error(`[turn] ${user.id}`, err);
    try {
      await deliver(user, ["ugh, something broke on my end. gimme a sec and try again?"], {
        proactive: false,
      });
    } catch {
      /* channel itself is down; nothing to do */
    }
  } finally {
    await sql`update users set turn_locked_at = null where id = ${user.id}`;
  }

  // Background memory passes — never block the reply on these.
  void refreshStyleProfile(user.id).catch((e) => console.error("[style]", e));
  void maybeRegenerateProfile(user).catch((e) => console.error("[profile]", e));
  return true;
}

async function maybeRegenerateProfile(user: User): Promise<void> {
  const stale =
    !user.profile_doc_at ||
    Date.now() - user.profile_doc_at.getTime() > 6 * 3600_000;
  if (stale) await regenerateProfile(user.id);
}

export function startTurnWorker(): void {
  const tick = async () => {
    try {
      // Drain rather than sleeping between each — bursts arrive together.
      while (await processOneTurn());
    } catch (err) {
      console.error("[turn worker]", err);
    } finally {
      setTimeout(tick, 500);
    }
  };
  void tick();
  console.log(`[turn worker] running (debounce ${config.limits.debounceMs}ms)`);
}
