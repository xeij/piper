import type Anthropic from "@anthropic-ai/sdk";
import { sql, type User } from "../db/index.js";
import { createLink } from "../web/links.js";
import { createEvent, listUpcoming } from "../integrations/google.js";

/**
 * Tool definitions render BEFORE the system prompt, so this array must be
 * byte-stable across requests or the whole prompt cache misses. Never build it
 * conditionally per user.
 */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "save_goal",
    description:
      "Record something the person is working toward. Call this the moment a real goal surfaces in conversation — don't wait for them to phrase it formally, and don't announce that you're saving it.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The goal in their own words, short." },
        why: { type: "string", description: "Why it matters to them, if they said." },
        cadence: { type: "string", description: "e.g. 'daily', '3x a week', 'by friday'." },
        target_date: { type: "string", description: "YYYY-MM-DD, if there's a deadline." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_goal",
    description:
      "Change a goal's status or note progress on it. Use the goal id from the context above.",
    input_schema: {
      type: "object",
      properties: {
        goal_id: { type: "number" },
        status: { type: "string", enum: ["active", "done", "paused", "dropped"] },
        progress: { type: "boolean", description: "True if they made progress just now." },
      },
      required: ["goal_id"],
      additionalProperties: false,
    },
  },
  {
    name: "log_checkin",
    description:
      "Log how they're actually doing right now. This is what you'll read back to them in a month, so write it as a fact, not a summary.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string" },
        goal_id: { type: "number" },
        sentiment: { type: "string", enum: ["good", "mixed", "rough"] },
      },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "remember_fact",
    description:
      "Store a specific detail worth bringing up later: a person in their life, a preference, a constraint, something that happened. Use a stable key so repeats overwrite rather than pile up.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["person", "preference", "context", "detail"] },
        key: { type: "string", description: "Stable slug, e.g. 'sister-wedding' or 'manager-dana'." },
        value: { type: "string" },
      },
      required: ["kind", "key", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_followup",
    description:
      "Schedule yourself to text them at a specific future time. REQUIRED whenever you tell someone you'll check back — saying it without calling this is lying to them.",
    input_schema: {
      type: "object",
      properties: {
        run_at: { type: "string", description: "ISO 8601 timestamp with offset." },
        intent: {
          type: "string",
          description:
            "What you want to say or find out then, in enough detail that it makes sense to you days later with no other context.",
        },
      },
      required: ["run_at", "intent"],
      additionalProperties: false,
    },
  },
  {
    name: "check_calendar",
    description: "Read their upcoming calendar events. Only works if calendar is connected.",
    input_schema: {
      type: "object",
      properties: { days: { type: "number", description: "How many days ahead. Default 7." } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "add_calendar_event",
    description:
      "Put something on their calendar. Just do it when it's obviously wanted; don't ask permission for something they already asked for.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 with offset." },
        end: { type: "string", description: "ISO 8601 with offset." },
        notes: { type: "string" },
      },
      required: ["title", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "send_link",
    description:
      "Get a personal link to send them: 'calendar' to connect Google Calendar, 'checkout' to subscribe. Returns the URL — you still have to write the message around it.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["calendar", "checkout"] },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "search_history",
    description:
      "Search everything they've ever texted you, for when something is older than the conversation you can see.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "stay_quiet",
    description:
      "Decide not to send anything. Only valid when you opened the conversation rather than replying. Use it freely — restraint is why people keep you in their messages.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

export type ToolOutcome = { text: string; quiet?: boolean };

export async function executeTool(
  user: User,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  switch (name) {
    case "save_goal": {
      const [row] = await sql<{ id: number }[]>`
        insert into goals (user_id, title, why, cadence, target_date)
        values (${user.id}, ${String(input.title)}, ${(input.why as string) ?? null},
                ${(input.cadence as string) ?? null}, ${(input.target_date as string) ?? null})
        returning id`;
      return { text: `saved as goal id ${row!.id}` };
    }

    case "update_goal": {
      const progress = input.progress === true;
      await sql`
        update goals set
          status = coalesce(${(input.status as string) ?? null}, status),
          last_progress_at = case when ${progress} then now() else last_progress_at end,
          updated_at = now()
        where id = ${Number(input.goal_id)} and user_id = ${user.id}`;
      return { text: "updated" };
    }

    case "log_checkin": {
      await sql`
        insert into checkins (user_id, goal_id, note, sentiment)
        values (${user.id}, ${(input.goal_id as number) ?? null},
                ${String(input.note)}, ${(input.sentiment as string) ?? null})`;
      if (input.goal_id) {
        await sql`update goals set last_progress_at = now()
                  where id = ${Number(input.goal_id)} and user_id = ${user.id}`;
      }
      return { text: "logged" };
    }

    case "remember_fact": {
      await sql`
        insert into facts (user_id, kind, key, value)
        values (${user.id}, ${String(input.kind)}, ${String(input.key)}, ${String(input.value)})
        on conflict (user_id, kind, key)
        do update set value = excluded.value, updated_at = now()`;
      return { text: "got it" };
    }

    case "schedule_followup": {
      const runAt = new Date(String(input.run_at));
      if (Number.isNaN(runAt.getTime())) {
        return { text: "that timestamp didn't parse — send ISO 8601 with an offset" };
      }
      if (runAt.getTime() < Date.now()) {
        return { text: "that time is in the past — pick a future one" };
      }
      await sql`
        insert into scheduled_messages (user_id, run_at, intent, source)
        values (${user.id}, ${runAt}, ${String(input.intent)}, 'agent')`;
      return { text: `follow-up set for ${runAt.toISOString()}` };
    }

    case "check_calendar": {
      const events = await listUpcoming(user, Number(input.days ?? 7));
      if (events === null) return { text: "calendar isn't connected" };
      if (!events.length) return { text: "nothing on the calendar in that window" };
      return { text: events.map((e) => `${e.start} — ${e.title}`).join("\n") };
    }

    case "add_calendar_event": {
      const created = await createEvent(user, {
        title: String(input.title),
        startIso: String(input.start),
        endIso: String(input.end),
        notes: input.notes as string | undefined,
      });
      if (created === null) return { text: "calendar isn't connected" };
      return { text: "added to their calendar" };
    }

    case "send_link": {
      const kind = input.kind === "checkout" ? "checkout" : "calendar";
      return { text: createLink(user.id, kind) };
    }

    case "search_history": {
      const q = String(input.query);
      const rows = await sql<{ direction: string; body: string; created_at: Date }[]>`
        select direction, body, created_at from messages
        where user_id = ${user.id} and body ilike ${"%" + q + "%"}
        order by created_at desc limit 10`;
      if (!rows.length) return { text: "nothing in the history about that" };
      return {
        text: rows
          .map(
            (r) =>
              `${r.created_at.toISOString().slice(0, 10)} ${r.direction === "in" ? "them" : "you"}: ${r.body}`,
          )
          .join("\n"),
      };
    }

    case "stay_quiet":
      return { text: "ok, saying nothing", quiet: true };

    default:
      return { text: `unknown tool: ${name}` };
  }
}
