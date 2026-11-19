import { config } from "./config.js";
import { sql, type User } from "./db/index.js";

/** Paying subscribers and numbers listed in FREE_PHONES never see the paywall. */
export function hasAccess(user: Pick<User, "phone" | "subscription_status">): boolean {
  return (
    user.subscription_status === "active" ||
    user.subscription_status === "trialing" ||
    config.limits.freePhones.includes(user.phone)
  );
}

/**
 * Pure paywall decision from the count of messages they've sent.
 * - free:  under FREE_MESSAGES, normal conversation
 * - pitch: free messages used up; the agent still replies and asks them to subscribe, in voice
 * - gate:  past the grace window; code answers with the checkout link and the model isn't called
 */
export function paywallState(inbound: number, access: boolean): "free" | "pitch" | "gate" {
  if (access) return "free";
  if (inbound > config.limits.freeMessages + config.limits.paywallGrace) return "gate";
  if (inbound >= config.limits.freeMessages) return "pitch";
  return "free";
}

export async function inboundCount(userId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from messages where user_id = ${userId} and direction = 'in'`;
  return row?.n ?? 0;
}

/**
 * Stage is recomputed from evidence on every inbound, so a lapsed subscription
 * drops back to the paywall on its own. Calendar is pitched only once there is
 * a real goal to hang it on.
 */
export async function advanceStage(user: User): Promise<User["onboarding_stage"]> {
  const [counts] = await sql<{ goals: number }[]>`
    select count(*)::int as goals from goals where user_id = ${user.id} and status = 'active'`;
  const inbound = await inboundCount(user.id);
  const goals = counts?.goals ?? 0;

  let next: User["onboarding_stage"] = "new";
  if (hasAccess(user)) next = "active";
  else if (paywallState(inbound, false) !== "free") next = "paywalled";
  else if (goals >= 1 && inbound >= 6) next = "calendar_pitched";
  else if (inbound >= 1) next = "discovering";

  if (next !== user.onboarding_stage) {
    await sql`update users set onboarding_stage = ${next} where id = ${user.id}`;
  }
  return next;
}
