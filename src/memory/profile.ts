import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { sql } from "../db/index.js";

const client = new Anthropic();

const DOSSIER_PROMPT = `
You maintain a running dossier on one person, written for a friend who texts
them and needs to remember things well.

Rewrite the dossier below using the new conversation. Rules:

- Under 350 words. Cut the least useful line before adding a new one.
- Concrete and specific. "sister Maya's wedding in October, he's giving a
  speech and dreading it" — not "has family events coming up".
- Keep what stays true (who's in their life, what they're chasing, what they're
  scared of, how they work). Drop what expired.
- Include how they're actually doing lately, not just facts.
- Prose in short paragraphs. No headers, no bullets.
- Never invent anything. If the conversation didn't say it, it doesn't go in.

Output only the dossier text.
`.trim();

/**
 * Memory layer 3. Regenerated periodically rather than retrieved per-turn:
 * for this product the context you need is almost always recent-and-salient,
 * not semantically similar, so a compact dossier beats RAG on both quality
 * and cost. Runs on Haiku — it's a summarization pass, not a reasoning one.
 */
export async function regenerateProfile(userId: string): Promise<void> {
  const [[user], recent] = await Promise.all([
    sql<{ profile_doc: string }[]>`select profile_doc from users where id = ${userId}`,
    sql<{ direction: string; body: string; created_at: Date }[]>`
      select direction, body, created_at from (
        select direction, body, created_at from messages
        where user_id = ${userId} order by created_at desc limit 80
      ) t order by created_at asc`,
  ]);
  if (!user || recent.length < 4) return;

  const transcript = recent
    .map(
      (m) =>
        `${m.created_at.toISOString().slice(0, 16)} ${m.direction === "in" ? "THEM" : "PIPER"}: ${m.body}`,
    )
    .join("\n");

  const response = await client.messages.create({
    model: config.models.background,
    max_tokens: 1200,
    system: DOSSIER_PROMPT,
    messages: [
      {
        role: "user",
        content: `CURRENT DOSSIER:\n${user.profile_doc || "(empty — this is the first pass)"}\n\nRECENT CONVERSATION:\n${transcript}`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) return;
  await sql`update users set profile_doc = ${text}, profile_doc_at = now() where id = ${userId}`;
}
