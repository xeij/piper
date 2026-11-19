# piper

An AI accountability partner that lives in iMessage. Text it what you're
working on, and it remembers, checks in when it matters, and talks like a
friend instead of an app.

**Text +1 (808) 319-9759** to get your own piper, or
**[open it in Messages](https://34-73-159-213.sslip.io)** from your phone.

There's no app to download and no account to make. Your first text is the
signup, and from then on piper is yours: its own memory of you, your goals and
the people in your life, kept separate from everyone else's.

## What it's like

> **you:** trying to finish my ml homework by friday\
> **piper:** how much is left\
> **you:** the whole second half lol\
> **piper:** ok so thursday is crunch time. i'll check on you wednesday night
>
> *wednesday, 8pm*
>
> **piper:** how's the ml homework, still the whole second half?

(Illustrative exchange.)

## What it does

- Picks up goals from normal conversation, without forms or setup.
- Remembers the people, plans and details you mention, and brings them up later.
- Texts first only when there's a reason: a check-in it promised, or a goal
  that's gone quiet. Otherwise it stays out of your messages.
- Adapts to how you text: length, capitalization, emoji.
- Puts plans on your Apple or Google Calendar.
- First 12 messages are free, then it's a monthly subscription through Stripe.

## How it's built

```
your iPhone ──iMessage──▶ Sendblue ──▶ piper server ──▶ Claude
                                            │
                                            ▼
                                   Postgres (memory, goals)
```

TypeScript on Node, Fastify, Postgres on Supabase, Claude (Anthropic), Sendblue
for iMessage, Stripe for billing. It runs as a single service on a small Linux
VM.

## Status

Live over iMessage. Billing and calendar sync are built and in testing.

## Running it locally

Requires Node 20+, a Postgres database and an Anthropic API key. Create a
`.env` with `DATABASE_URL`, `ANTHROPIC_API_KEY` and `LINK_SIGNING_SECRET`, then:

```bash
npm install
npm run db:push
npm run sim -- +15550001111   # chat with piper in the terminal, no phone needed
```
