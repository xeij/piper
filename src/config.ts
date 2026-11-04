import "dotenv/config";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const config = {
  databaseUrl: req("DATABASE_URL"),
  publicBaseUrl: opt("PUBLIC_BASE_URL", "http://localhost:3000"),
  linkSigningSecret: opt("LINK_SIGNING_SECRET", "dev-secret-change-me"),

  // Sonnet 5 for the conversational loop; Haiku for cheap background passes.
  models: {
    chat: "claude-sonnet-5",
    background: "claude-haiku-4-5",
  },

  channel: {
    provider: opt("CHANNEL_PROVIDER", "twilio") as "sendblue" | "twilio",
    sendblue: {
      apiKey: opt("SENDBLUE_API_KEY"),
      apiSecret: opt("SENDBLUE_API_SECRET"),
      from: opt("SENDBLUE_FROM_NUMBER"),
      // Set the same value as the webhook secret in the Sendblue dashboard.
      webhookSecret: opt("SENDBLUE_WEBHOOK_SECRET"),
    },
    twilio: {
      accountSid: opt("TWILIO_ACCOUNT_SID"),
      authToken: opt("TWILIO_AUTH_TOKEN"),
      from: opt("TWILIO_FROM_NUMBER"),
    },
  },

  google: {
    clientId: opt("GOOGLE_CLIENT_ID"),
    clientSecret: opt("GOOGLE_CLIENT_SECRET"),
    // Least-privilege: events only, never full calendar scope.
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
  },

  stripe: {
    secretKey: opt("STRIPE_SECRET_KEY"),
    webhookSecret: opt("STRIPE_WEBHOOK_SECRET"),
    priceMonthly: opt("STRIPE_PRICE_MONTHLY"),
    priceYearly: opt("STRIPE_PRICE_YEARLY"),
  },

  limits: {
    // Delivery cost scales with bubbles sent, not tokens. These are the
    // knobs that keep a heavy user from going cash-flow negative.
    maxBubblesPerReply: num("MAX_BUBBLES_PER_REPLY", 3),
    maxProactivePerDay: num("MAX_PROACTIVE_PER_DAY", 4),
    trialDays: num("TRIAL_DAYS", 5),
    // Wait this long after the last inbound before running a turn, so a
    // burst of short texts is treated as one thought.
    debounceMs: num("DEBOUNCE_MS", 3000),
    maxAgentIterations: num("MAX_AGENT_ITERATIONS", 8),
    historyTurns: num("HISTORY_TURNS", 40),
  },

  port: num("PORT", 3000),
};

export const ACTIVATION_PHRASE = "yo what is piper";
