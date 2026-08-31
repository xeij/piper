import { sql, type StyleProfile } from "../db/index.js";

const EMOJI = /\p{Extended_Pictographic}/gu;
const KNOWN_ABBREVS = [
  "lol","lmao","idk","ngl","tbh","fr","imo","rn","btw","omg","ty","np","yea",
  "yeah","nah","ok","okay","gonna","wanna","kinda","sorta","prob","def","w/e","tmrw",
];

/**
 * Derived from the user's OWN outgoing texts. This is what stops the agent
 * cosplaying a demographic: it only ever mirrors slang it has actually seen
 * this person use.
 */
export async function deriveStyleProfile(userId: string): Promise<StyleProfile | null> {
  const rows = await sql<{ body: string }[]>`
    select body from messages
    where user_id = ${userId} and direction = 'in'
    order by created_at desc limit 60`;
  if (rows.length < 4) return null;

  const bodies = rows.map((r) => r.body).filter((b) => b.trim().length > 0);
  if (!bodies.length) return null;

  const lengths = bodies.map((b) => b.length).sort((a, b) => a - b);
  const medianLength = lengths[Math.floor(lengths.length / 2)]!;

  const withLetters = bodies.filter((b) => /[a-z]/i.test(b));
  const lowercaseRate = withLetters.length
    ? withLetters.filter((b) => b === b.toLowerCase()).length / withLetters.length
    : 0;

  const emojiCounts = new Map<string, number>();
  let msgsWithEmoji = 0;
  for (const b of bodies) {
    const found = b.match(EMOJI);
    if (found?.length) {
      msgsWithEmoji++;
      for (const e of found) emojiCounts.set(e, (emojiCounts.get(e) ?? 0) + 1);
    }
  }
  const topEmoji = [...emojiCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([e]) => e);

  const endsWithPeriodRate =
    bodies.filter((b) => /\.\s*$/.test(b.trim())).length / bodies.length;

  const lowerAll = bodies.join(" ").toLowerCase();
  const abbreviations = KNOWN_ABBREVS.filter((a) =>
    new RegExp(`(^|[^a-z])${a.replace("/", "\\/")}([^a-z]|$)`).test(lowerAll),
  );

  // Verbatim samples do more work than any statistic — the model matches a
  // voice from examples better than from numbers.
  const samples = bodies
    .filter((b) => b.length > 12 && b.length < 160)
    .slice(0, 5);

  return {
    medianLength,
    lowercaseRate: Number(lowercaseRate.toFixed(2)),
    emojiRate: Number((msgsWithEmoji / bodies.length).toFixed(2)),
    topEmoji,
    endsWithPeriodRate: Number(endsWithPeriodRate.toFixed(2)),
    abbreviations,
    samples,
  };
}

export async function refreshStyleProfile(userId: string): Promise<void> {
  const style = await deriveStyleProfile(userId);
  if (!style) return;
  await sql`update users set style_profile = ${sql.json(style)} where id = ${userId}`;
}
