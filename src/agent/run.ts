import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { sql, type Fact, type Goal, type User } from "../db/index.js";
import { PIPER_CORE, buildUserBlock, type PromptContext } from "./prompt.js";
import { TOOLS, executeTool } from "./tools.js";

const client = new Anthropic();

export type AgentResult = {
  bubbles: string[];
  quiet: boolean;
  usage: { input: number; output: number; cacheRead: number };
};

async function loadContext(
  user: User,
  trigger: PromptContext["trigger"],
  triggerIntent?: string,
): Promise<PromptContext> {
  const [goals, facts, recentCheckins] = await Promise.all([
    sql<Goal[]>`select * from goals where user_id = ${user.id}
                order by status = 'active' desc, updated_at desc limit 25`,
    sql<Fact[]>`select id, kind, key, value from facts where user_id = ${user.id}
                order by updated_at desc limit 40`,
    sql<{ note: string; sentiment: string | null; created_at: Date }[]>`
      select note, sentiment, created_at from checkins
      where user_id = ${user.id} order by created_at desc limit 8`,
  ]);
  return { user, goals, facts, recentCheckins, trigger, triggerIntent };
}

async function loadHistory(userId: string): Promise<Anthropic.MessageParam[]> {
  const rows = await sql<{ direction: string; body: string }[]>`
    select direction, body from (
      select direction, body, created_at from messages
      where user_id = ${userId} order by created_at desc limit ${config.limits.historyTurns}
    ) t order by created_at asc`;

  const msgs: Anthropic.MessageParam[] = rows.map((r) => ({
    role: r.direction === "in" ? "user" : "assistant",
    content: r.body,
  }));
  // The API requires the first message to be from the user.
  while (msgs.length && msgs[0]!.role === "assistant") msgs.shift();
  return msgs;
}

export async function runAgent(
  user: User,
  opts: { trigger: PromptContext["trigger"]; triggerIntent?: string },
): Promise<AgentResult> {
  const ctx = await loadContext(user, opts.trigger, opts.triggerIntent);
  const messages = await loadHistory(user.id);

  if (opts.trigger !== "inbound") {
    // Proactive turns need a trailing user turn to generate against. The real
    // instructions live in the cached system block; this is just the trigger.
    messages.push({
      role: "user",
      content: `<system-trigger>It is time for you to reach out. Reason: ${
        opts.triggerIntent ?? "scheduled check-in"
      }. This is not a message from them — do not reply to it as if it were.</system-trigger>`,
    });
  }

  if (!messages.length) {
    return { bubbles: [], quiet: true, usage: { input: 0, output: 0, cacheRead: 0 } };
  }

  const usage = { input: 0, output: 0, cacheRead: 0 };
  let quiet = false;
  let retriedEmpty = false;
  let finalText = "";

  for (let i = 0; i < config.limits.maxAgentIterations; i++) {
    const response = await client.messages.create({
      model: config.models.chat,
      max_tokens: 2000,
      // Sonnet 5: adaptive is the only on-mode, budget_tokens is removed, and
      // temperature/top_p are rejected outright. Low effort keeps a texting
      // turn cheap — the outbound pacing delay hides the latency anyway.
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: [
        // Byte-identical for every user in the system → one 1h-TTL cache entry
        // serves the entire user base at ~10% of input cost.
        { type: "text", text: PIPER_CORE, cache_control: { type: "ephemeral", ttl: "1h" } },
        // Per-user, stable within a conversation.
        { type: "text", text: buildUserBlock(ctx), cache_control: { type: "ephemeral" } },
      ],
      tools: TOOLS,
      messages,
    });

    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;

    if (response.stop_reason === "refusal") {
      // Rare, but must not become silence — the product promise is that it
      // always replies.
      return {
        bubbles: ["sorry, i can't get into that one. what else is going on?"],
        quiet: false,
        usage,
      };
    }

    finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!finalText && response.stop_reason !== "tool_use") {
      console.warn("[agent] empty reply", {
        stop: response.stop_reason,
        blocks: response.content.map((b) => b.type),
        out: response.usage.output_tokens,
      });
      // The model occasionally ends a turn with thinking and no text. On a
      // reply that must never become silence, so take one more pass with the
      // same history before giving up. Proactive turns may legitimately be empty.
      if (opts.trigger === "inbound" && !quiet && !retriedEmpty) {
        retriedEmpty = true;
        continue;
      }
    }

    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      try {
        const out = await executeTool(user, tu.name, tu.input as Record<string, unknown>);
        if (out.quiet) quiet = true;
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out.text });
      } catch (err) {
        // Hand the failure back so it can recover in-conversation rather than
        // dying mid-turn and leaving the user on read.
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `failed: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  if (quiet) return { bubbles: [], quiet: true, usage };

  return { bubbles: splitBubbles(finalText), quiet: false, usage };
}

/**
 * The model marks bubble breaks with a blank line. We only enforce the cap —
 * it knows better than a heuristic where a text should break, and each extra
 * bubble is real delivery cost.
 */
// The prompt forbids these, but the model still slips; texts must never carry them.
export function scrubAiTells(text: string): string {
  return text
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/\*\*|__|`/g, "")
    .replace(/^[ \t]*(#+|[-*•]|\d+\.)[ \t]+/gm, "")
    .replace(/^, |, $/gm, "");
}

export function splitBubbles(text: string): string[] {
  const parts = scrubAiTells(text)
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+$/g, "").trim())
    .filter(Boolean);

  if (parts.length <= config.limits.maxBubblesPerReply) return parts;

  const capped = parts.slice(0, config.limits.maxBubblesPerReply - 1);
  capped.push(parts.slice(config.limits.maxBubblesPerReply - 1).join(" "));
  return capped;
}
