/**
 * Dependency-free checks for the pure logic — bubble capping, quiet hours,
 * link signing, and the iOS/Android deep-link split. No database, no network.
 *   npm run selftest
 */
process.env.DATABASE_URL ||= "postgres://selftest/selftest";
process.env.LINK_SIGNING_SECRET = "selftest-secret-abcdefghijklmnop";
process.env.PUBLIC_BASE_URL = "https://piper.test";
process.env.CHANNEL_PROVIDER = "sendblue";
process.env.SENDBLUE_FROM_NUMBER = "+15551234567";

const { splitBubbles } = await import("./agent/run.js");
const { inQuietHours, localHour } = await import("./outbound/send.js");
const { createLink, verifyLink } = await import("./web/links.js");
const { landingPage } = await import("./web/pages.js");
const { secretMatches } = await import("./server.js");

let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  console.log(`${cond ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}`);
  if (!cond) {
    fail++;
    if (extra !== undefined) console.log("       ", extra);
  }
};

// --- bubble splitting: the cap is a cost control, so overflow must merge ---
ok("single bubble stays one", splitBubbles("lol nice").length === 1);
ok("blank line splits", splitBubbles("lol\n\nyou said 6am tho").length === 2);
const many = splitBubbles("a\n\nb\n\nc\n\nd\n\ne");
ok("caps at MAX_BUBBLES (3)", many.length === 3, many);
ok("overflow merged, not dropped", many[2] === "c d e", many);
ok("empty text -> no bubbles", splitBubbles("   ").length === 0);

// --- quiet hours: wrap-around window 22:00 -> 08:00 local ---
const u = (tz: string) =>
  ({ timezone: tz, quiet_hours_start: 22, quiet_hours_end: 8 }) as never as Parameters<
    typeof inQuietHours
  >[0];
const at = (iso: string) => new Date(iso);
ok("2am local is quiet", inQuietHours(u("America/New_York"), at("2026-01-15T07:00:00Z")));
ok("2pm local is not quiet", !inQuietHours(u("America/New_York"), at("2026-01-15T19:00:00Z")));
ok("midnight local is quiet", inQuietHours(u("America/New_York"), at("2026-01-15T05:00:00Z")));
ok("9am local is not quiet", !inQuietHours(u("America/New_York"), at("2026-01-15T14:00:00Z")));
ok(
  "timezone respected (LA vs NY)",
  localHour(u("America/Los_Angeles"), at("2026-01-15T19:00:00Z")) === 11 &&
    localHour(u("America/New_York"), at("2026-01-15T19:00:00Z")) === 14,
);
ok("hour 0 normalizes, not 24", localHour(u("UTC"), at("2026-01-15T00:30:00Z")) === 0);

// --- signed magic links ---
const link = createLink("user-abc", "calendar", 60);
const token = new URL(link).searchParams.get("t")!;
ok("calendar link routes to /connect/google", link.includes("/connect/google"));
ok("checkout link routes to /subscribe", createLink("u", "checkout").includes("/subscribe"));
ok("valid token verifies", verifyLink(token)?.uid === "user-abc");
ok("tampered payload rejected", verifyLink("eyJ1aWQiOiJoYWNrZXIifQ." + token.split(".")[1]) === null);
ok("tampered signature rejected", verifyLink(token.split(".")[0] + ".AAAA") === null);
ok("garbage rejected", verifyLink("nonsense") === null);

// --- webhook secret: a near-miss or a missing header must not pass ---
ok("webhook secret matches", secretMatches("abc123", "abc123"));
ok("webhook secret wrong rejected", !secretMatches("abc124", "abc123"));
ok("webhook secret length mismatch rejected", !secretMatches("abc12", "abc123"));
ok("webhook secret missing header rejected", !secretMatches(undefined, "abc123"));
ok(
  "expired token rejected",
  verifyLink(new URL(createLink("u", "calendar", -1)).searchParams.get("t")!) === null,
);

// --- landing page: the deep link IS the signup, and it differs per platform ---
const page = landingPage();
ok("iOS deep link uses &body=", page.includes("sms:+15551234567&body=yo%20what%20is%20piper"));
ok("Android fallback uses ?body=", page.includes("sms:+15551234567?body=yo%20what%20is%20piper"));
ok("discloses AI and price", page.includes("an ai") && page.includes("19.99"));
ok("carries STOP disclosure", page.includes("STOP"));

console.log(fail ? `\n\x1b[31m${fail} failing\x1b[0m` : "\n\x1b[32mall green\x1b[0m");
process.exit(fail ? 1 : 0);

export {};
