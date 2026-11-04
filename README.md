# piper

An AI that lives in your text messages, keeps track of what you said you'd do,
and follows up like a friend would.

## The shape of it

```
sms: deep link  →  /webhooks/inbound  →  debounce (~3s)  →  agent turn  →  paced outbound
                                                              │
                                          ┌───────────────────┼───────────────────┐
                                   schedule_followup    style profile        dossier
                                   (agent's own tool)   (mirrors THEM)    (Haiku, background)
                                          │
                                   followup worker  ←  nightly sweep (Haiku gate: "should we
                                                        text at all?" — default answer is no)
```

Three design commitments everything else follows from:

**Debounce inbound.** People text in bursts. Replying to `hey` before they've
finished the thought is the loudest bot tell there is, so each inbound pushes
`users.pending_turn_at` forward and the turn only runs once the burst stops.

**Pace outbound.** Typing indicator, then a delay proportional to length. An
instant reply to a paragraph is as robotic as a slow reply to `hey` is uncanny.

**Saying nothing is a first-class outcome.** The sweep's default answer is _no_
and the agent has a `stay_quiet` tool. Restraint is the whole difference between
a product people keep and one they mute.

## Unit economics — read this before scaling

**Your cost driver is messages delivered, not tokens.** Roughly, per active user
per month at ~15 exchanges/day:

| Line item                                 | Cost        |
| ----------------------------------------- | ----------- |
| Sonnet 5 chat turns (with prompt caching) | ~$2         |
| Haiku background passes (dossier + sweep) | ~$0.30      |
| SMS via Twilio                            | ~$7         |
| **iMessage relay at ~$0.02/msg**          | **~$18–27** |
| Stripe on $19.99                          | $0.88       |

A heavy user on a relay is cash-flow negative at $19.99. Two knobs in
`config.limits` exist for exactly this: `maxBubblesPerReply` and
`maxProactivePerDay`. Splitting one reply into three bubbles is what makes it
feel human _and_ triples delivery cost — that tension is the core product
tradeoff and it's why the cap is a config value, not a constant.

Model your **P90** user, not your average, before committing to the annual price.

## Setup

```bash
npm install
cp .env.example .env      # fill it in
npm run db:push           # apply schema.sql
npm run selftest          # pure-logic checks, no DB or network needed
npm run dev
```

### Test the voice before you buy a phone number

```bash
npm run sim -- +15550001111
```

A terminal harness running the **real** prompt, memory, and tools against the
real database — only the SMS transport is stubbed. It prints per-turn latency
and cache hit rate.

```
/state              inspect dossier, style profile, goals, scheduled follow-ups
/followup <intent>  force a proactive turn
/reset              wipe the sim user
```

Spend a week here before anything else. The voice is the only part of this that
can't be copied, and you'll learn more from seven days of texting it yourself
than from a month of building the platform around it.

## Layout

| Path                    | What                                                        |
| ----------------------- | ----------------------------------------------------------- |
| `src/agent/prompt.ts`   | **The moat.** Voice rules, banned phrases, stage guidance.  |
| `src/agent/style.ts`    | Derives texting style from the user's _own_ messages.       |
| `src/agent/run.ts`      | Agent loop, two cache breakpoints, bubble capping.          |
| `src/agent/tools.ts`    | Goals, check-ins, facts, follow-ups, calendar, links.       |
| `src/memory/profile.ts` | Rolling dossier (memory layer 3).                           |
| `src/channels/`         | `Channel` interface + Sendblue (iMessage) and Twilio (SMS). |
| `src/workers/`          | Debounced turns, due follow-ups, nightly sweep.             |
| `src/onboarding.ts`     | Funnel stages — advance on value delivered, never a timer.  |

## Prompt caching

`PIPER_CORE` is byte-identical for every user, cached at 1h TTL, so **one cache
entry serves the entire user base** at ~10% of input cost. Never interpolate
anything into it — a single dynamic character invalidates it for everyone.
Tool definitions render _before_ the system prompt, so `TOOLS` must stay
byte-stable too. Watch `cache_read_input_tokens` in the sim output; if it's 0
across turns, something upstream is varying.

## Memory, in three layers

1. `messages` — raw log, append-only.
2. `goals` / `checkins` / `facts` — structured entities the agent writes via
   tools and references _by name_. This is what powers "how'd the thing with
   your manager go" — the highest-value moment in the product.
3. `users.profile_doc` — a compact dossier regenerated on Haiku every ~6h and
   injected into every prompt.

Deliberately **not** a vector DB. For this product the context you need is
almost always recent-and-salient, not semantically similar; a dossier beats RAG
on both quality and cost. `search_history` covers the rare old-memory lookup.

## Compliance — built in, not bolted on

- **Opt-in**: the user texts first. Cleanest possible TCPA consent record.
- **STOP / START / HELP** handled in code (`src/inbound.ts`), never by the model.
- **AI disclosure**: California SB 1001 requires disclosing a bot when it's
  communicating to incentivize a purchase — which is exactly what onboarding
  does. `PIPER_CORE` requires disclosure _before_ any paywall pitch, in voice.
  Don't fight this; "yeah i'm an ai, but i'm good at this" converts fine, and a
  late reveal costs more trust than the upfront line.
- **Crisis handling**: `PIPER_CORE` drops the persona entirely for self-harm,
  abuse, and disordered-eating signals and routes to 988. An accountability
  product _will_ receive these messages.
- **Google scope**: `calendar.events` only. It's a _sensitive_ scope — OAuth
  verification is required past 100 users. **Start that now**; 2–6 weeks is a
  common launch blocker.

## Known risks

- **Relay bans.** iMessage relays operate against Apple's ToS and numbers get
  burned with no notice. Everything sits behind `Channel` so
  `CHANNEL_PROVIDER=twilio` migrates the whole user base in one deploy. Keep the
  Twilio number registered and warm.
- **10DLC.** SMS fallback won't deliver reliably until A2P registration clears.
  Do it before you need it.
- **Churn is the business.** These products die in week 3 when people stop
  replying, not at acquisition. Instrument reply-rate-by-day-since-signup and
  treat it as the north star.
