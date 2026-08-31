import { config } from "./config.js";
import { sql, type User } from "./db/index.js";

/**
 * Funnel stages advance on evidence of value delivered, never on a timer alone.
 * Asking for calendar access or money before you've been useful is the fastest
 * way to lose someone who is one tap from deleting the thread.
 */
export async function advanceStage(user: User): Promise<User["onboarding_stage"]> {
  const stage = user.onboarding_stage;
  if (stage === "active") return stage;

  if (user.subscription_status === "active") {
    await setStage(user.id, "active");
    return "active";
  }

  const [counts] = await sql<{ inbound: number; goals: number }[]>`
    select
      (select count(*)::int from messages where user_id = ${user.id} and direction = 'in') as inbound,
      (select count(*)::int from goals where user_id = ${user.id} and status = 'active') as goals`;

  const inbound = counts?.inbound ?? 0;
  const goals = counts?.goals ?? 0;
  const ageDays = (Date.now() - user.created_at.getTime()) / 86400000;

  let next = stage;

  if (stage === "new" && inbound >= 1) next = "discovering";

  // Only pitch the calendar once there's a real goal to hang it on.
  if (next === "discovering" && goals >= 1 && inbound >= 8) next = "calendar_pitched";

  // Paywall lands near the end of the trial, after several days of use.
  if (
    next === "calendar_pitched" &&
    (ageDays >= config.limits.trialDays - 1 || inbound >= 25)
  ) {
    next = "paywalled";
  }

  if (next !== stage) {
    await setStage(user.id, next);
    if (next === "discovering" && !user.trial_ends_at) {
      await sql`update users set trial_ends_at = now() + (${config.limits.trialDays} || ' days')::interval
                where id = ${user.id}`;
    }
  }
  return next;
}

async function setStage(userId: string, stage: User["onboarding_stage"]) {
  await sql`update users set onboarding_stage = ${stage} where id = ${userId}`;
}
