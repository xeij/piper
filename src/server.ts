import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { config, ACTIVATION_PHRASE } from "./config.js";
import { sql, type User } from "./db/index.js";
import { channel } from "./channels/index.js";
import { handleInbound } from "./inbound.js";
import { verifyLink } from "./web/links.js";
import { consentUrl, oauthClient } from "./integrations/google.js";
import { checkoutUrl, stripe } from "./integrations/stripe.js";
import { landingPage, notice } from "./web/pages.js";

export function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function buildServer() {
  const app = Fastify({ logger: true });

  // Stripe signature verification needs the exact bytes, not parsed JSON.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      const buf = body as Buffer;
      (req as { rawBody?: Buffer }).rawBody = buf;
      try {
        done(null, buf.length ? JSON.parse(buf.toString("utf8")) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get("/health", async () => ({ ok: true }));

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(landingPage());
  });

  // --- channel webhook -----------------------------------------------------
  app.post("/webhooks/inbound", async (req, reply) => {
    // The URL is public. Without this, anyone who finds it can spoof an
    // inbound text and make us reply to arbitrary numbers on our bill.
    const secret = config.channel.sendblue.webhookSecret;
    if (config.channel.provider === "sendblue" && secret) {
      if (!secretMatches(req.headers["sb-signing-secret"], secret)) {
        app.log.warn({ headers: Object.keys(req.headers) }, "webhook rejected: bad secret");
        reply.code(401).send({ ok: false });
        return;
      }
    }
    const msg = channel.parseWebhook(req.body);
    // 200 fast regardless — providers retry aggressively on anything else.
    reply.send({ ok: true });
    if (!msg) return;
    handleInbound(msg).catch((err) => app.log.error({ err }, "inbound failed"));
  });

  // --- google calendar oauth ----------------------------------------------
  app.get("/connect/google", async (req, reply) => {
    const token = (req.query as { t?: string })?.t ?? "";
    const payload = verifyLink(token);
    if (!payload || payload.kind !== "calendar") {
      return reply.type("text/html").send(notice("that link expired", "text piper and ask for a new one."));
    }
    reply.redirect(consentUrl(token));
  });

  app.get("/connect/google/callback", async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const payload = state ? verifyLink(state) : null;
    if (!code || !payload) {
      return reply.type("text/html").send(notice("couldn't connect", "the link expired. ask piper for a fresh one."));
    }
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      return reply
        .type("text/html")
        .send(notice("almost", "google didn't hand over a refresh token. try again and pick 'allow'."));
    }
    await sql`update users set google_refresh_token = ${tokens.refresh_token} where id = ${payload.uid}`;

    const [user] = await sql<User[]>`select * from users where id = ${payload.uid}`;
    if (user) {
      // Confirm in-thread, in voice — the web page is not where the product is.
      await channel.send(user.phone, "got it, i can see your calendar now");
      await sql`insert into messages (user_id, direction, body, proactive)
                values (${user.id}, 'out', 'got it, i can see your calendar now', true)`;
    }
    reply.type("text/html").send(notice("connected", "go back to your messages."));
  });

  // --- stripe --------------------------------------------------------------
  app.get("/subscribe", async (req, reply) => {
    const q = req.query as { t?: string; plan?: string };
    const payload = verifyLink(q.t ?? "");
    if (!payload || payload.kind !== "checkout") {
      return reply.type("text/html").send(notice("that link expired", "text piper for a new one."));
    }
    const [user] = await sql<User[]>`select * from users where id = ${payload.uid}`;
    if (!user) return reply.type("text/html").send(notice("hm", "couldn't find that account."));
    const url = await checkoutUrl(user, q.plan === "yearly" ? "yearly" : "monthly");
    reply.redirect(url);
  });

  app.get("/subscribe/done", async (_req, reply) =>
    reply.type("text/html").send(notice("you're in", "go back to your messages.")),
  );
  app.get("/subscribe/cancelled", async (_req, reply) =>
    reply.type("text/html").send(notice("no worries", "nothing was charged.")),
  );

  app.post("/webhooks/stripe", async (req, reply) => {
    const sig = req.headers["stripe-signature"];
    const raw = (req as { rawBody?: Buffer }).rawBody;
    if (!sig || !raw) return reply.code(400).send("missing signature");

    let event;
    try {
      event = stripe().webhooks.constructEvent(raw, sig as string, config.stripe.webhookSecret);
    } catch (err) {
      app.log.error({ err }, "bad stripe signature");
      return reply.code(400).send("bad signature");
    }

    const dedupe = await sql`
      insert into processed_events (id) values (${`stripe_${event.id}`})
      on conflict (id) do nothing returning id`;
    if (dedupe.length === 0) return reply.send({ received: true });

    await handleStripeEvent(event);
    reply.send({ received: true });
  });

  return app;
}

async function handleStripeEvent(event: { type: string; data: { object: unknown } }) {
  const obj = event.data.object as Record<string, unknown>;

  if (event.type === "checkout.session.completed") {
    const userId = (obj.client_reference_id ?? (obj.metadata as Record<string, string>)?.piper_user_id) as string;
    if (!userId) return;
    await sql`
      update users set subscription_status = 'active', onboarding_stage = 'active',
                       stripe_customer_id = ${(obj.customer as string) ?? null}
      where id = ${userId}`;
    const [user] = await sql<User[]>`select * from users where id = ${userId}`;
    if (user) await channel.send(user.phone, "you're in. ok back to it.");
    return;
  }

  if (event.type.startsWith("customer.subscription.")) {
    const userId = (obj.metadata as Record<string, string>)?.piper_user_id;
    if (!userId) return;
    const status = String(obj.status);
    const mapped =
      status === "active" || status === "trialing"
        ? status === "trialing" ? "trialing" : "active"
        : status === "past_due" ? "past_due" : "canceled";
    await sql`update users set subscription_status = ${mapped} where id = ${userId}`;
  }
}

export { ACTIVATION_PHRASE };
