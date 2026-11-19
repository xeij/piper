# piper

An AI accountability partner that lives in iMessage. It remembers goals people
mention in conversation, checks in on them at the right time, and texts like a
friend rather than a productivity app.

Stack: TypeScript on Node 20+, Fastify, Postgres (Supabase), Claude via the
Anthropic SDK, Sendblue for iMessage (Twilio for SMS).

## Status

Personal project, running end to end for a single user: real iMessages arrive
through Sendblue, the agent replies, and follow-ups fire on schedule. Code for
Stripe billing, Google Calendar, and the Twilio SMS fallback exists but has not
been exercised against live accounts. The memory dossier is not yet
regenerated on the live path (see Memory). There is no deployment; the server runs
locally behind a Cloudflare quick tunnel.

## Quickstart

Prerequisites: Node 20+, a Postgres database, an Anthropic API key. A Sendblue
account is only needed for real texting; the simulator works without it.

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL, ANTHROPIC_API_KEY, LINK_SIGNING_SECRET
npm run db:push           # apply src/db/schema.sql
npm run selftest          # pure-logic checks, no DB or network
npm run sim -- +15550001111
```

`npm run sim` runs the real prompt, memory, tools, and database from a terminal,
with only the message transport stubbed. It prints per-turn latency and prompt
cache hit rate. `/state` dumps what the agent knows about the user,
`/followup <intent>` forces a proactive turn, and `/reset` wipes the sim user.

With Supabase, use the **session pooler** connection string (port 5432). The
direct connection is IPv6-only and the transaction pooler breaks prepared
statements.

### Real iMessage

1. Fill in `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET` and `SENDBLUE_FROM_NUMBER`
   from the Sendblue dashboard, and set `SENDBLUE_WEBHOOK_SECRET` to any random
   string.
2. `npm run dev`, then expose it: `cloudflared tunnel --url http://localhost:3000`.
   Set `PUBLIC_BASE_URL` to the tunnel URL.
3. In Sendblue, under Developer → Webhooks → Inbound messages, add
   `<PUBLIC_BASE_URL>/webhooks/inbound` with the same secret.
4. Text the Sendblue number. On Sendblue's free plan a contact must message the
   number first before the API can send to them.

## How it works

```
iMessage → /webhooks/inbound → debounce (~3s) → agent turn → paced outbound
                                                    │
                       ┌────────────────────────────┼──────────────────────┐
                schedule_followup             style profile            dossier
                (agent's own tool)        (mirrors the user)     (Haiku, background)
                       │
                followup worker  ←  nightly sweep (Haiku decides whether to text at all)
```

Chat turns run on Claude Sonnet; background jobs (dossier rewrites, the nightly
sweep) run on Haiku.

**Inbound is debounced.** People text in bursts. Each message pushes
`users.pending_turn_at` forward, and the agent only runs once the burst stops,
so it never answers "hey" before the actual thought arrives.

**Outbound is paced.** A typing indicator, then a delay proportional to reply
length. Replies split on blank lines into separate bubbles, capped by
`MAX_BUBBLES_PER_REPLY`.

**Silence is a valid outcome.** The agent has a `stay_quiet` tool, and the
nightly sweep defaults to not texting. A proactive message has to earn its
send.

**Voice is enforced in two places.** `src/agent/prompt.ts` sets the register
(casual, lowercase, short, no markdown). Because models still slip, every
outgoing reply also passes through `scrubAiTells()` in `src/agent/run.ts`,
which strips em dashes, bold, headers and list markers. Style mirroring
(`src/agent/style.ts`) adapts length, capitalization and emoji to the user's own
texts.

### Memory

1. `messages`: raw append-only log.
2. `goals`, `checkins`, `facts`: structured rows the agent writes through tools
   and refers to by name ("how'd the thing with your manager go").
3. `users.profile_doc`: a compact dossier Haiku rewrites from recent
   conversation, injected into each prompt. Regeneration is currently triggered
   only by the simulator; the live server does not schedule it yet.

There is no vector store. The context this product needs is almost always
recent and salient rather than semantically similar, so a dossier beats
retrieval on both quality and cost. `search_history` covers the rare lookup of
something old.

### Prompt caching

`PIPER_CORE` is byte-identical for every user and cached with a 1-hour TTL, so
one cache entry serves everyone. Nothing may be interpolated into it, and tool
definitions (rendered before the system prompt) must stay byte-stable too.
Per-user context goes after the cache breakpoint. The simulator reports
`cache_read_input_tokens` to catch regressions.

### Cost constraint

Message delivery, not tokens, dominates cost. An iMessage relay charges per
message, and on rough estimates it costs several times more per active user
than the model calls do. Splitting a reply into bubbles makes it read as human
and multiplies delivery cost, which is why bubble count and proactive sends per
day are config values (`MAX_BUBBLES_PER_REPLY`, `MAX_PROACTIVE_PER_DAY`) rather
than constants.

### Channels

Everything goes through the `Channel` interface in `src/channels/`.
`CHANNEL_PROVIDER` switches between Sendblue (iMessage) and Twilio (SMS).
iMessage relays operate outside Apple's terms and numbers can be revoked
without notice, so the SMS path exists as a one-variable fallback.

### Safety and compliance

- STOP / START / HELP are handled in code (`src/inbound.ts`), never by the model.
- The agent discloses that it is an AI when asked, and before any payment ask.
- Self-harm, abuse, and disordered-eating signals make the prompt drop the
  persona and point to crisis resources.
- Inbound webhooks are rejected without the shared Sendblue secret.
- Google Calendar access is limited to the `calendar.events` scope.

## Layout

| Path                    | Contents                                                    |
| ----------------------- | ----------------------------------------------------------- |
| `src/agent/prompt.ts`   | Voice rules, banned phrases, onboarding stage guidance      |
| `src/agent/run.ts`      | Agent loop, cache breakpoints, bubble splitting and scrubbing |
| `src/agent/tools.ts`    | Goals, check-ins, facts, follow-ups, calendar, links        |
| `src/agent/style.ts`    | Texting style derived from the user's own messages          |
| `src/memory/profile.ts` | Dossier regeneration                                        |
| `src/channels/`         | `Channel` interface, Sendblue and Twilio implementations    |
| `src/workers/`          | Debounced turns, due follow-ups, nightly sweep              |
| `src/onboarding.ts`     | Funnel stages, advanced by value delivered rather than time |
| `src/db/schema.sql`     | Full schema                                                 |
| `src/sim.ts`            | Terminal simulator                                          |
