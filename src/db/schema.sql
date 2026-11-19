-- Piper schema. Postgres 14+.

create extension if not exists "pgcrypto";

create table if not exists users (
  id                  uuid primary key default gen_random_uuid(),
  phone               text unique not null,
  channel             text not null default 'sms',        -- 'imessage' | 'sms'
  display_name        text,
  timezone            text not null default 'Europe/Madrid',

  -- funnel
  onboarding_stage    text not null default 'new',        -- new | discovering | calendar_pitched | paywalled | active
  subscription_status text not null default 'none',       -- none | trialing | active | past_due | canceled
  trial_ends_at       timestamptz,
  stripe_customer_id  text,

  -- integrations
  google_refresh_token text,

  -- memory layer 3: the rolling dossier injected into every prompt
  profile_doc         text not null default '',
  profile_doc_at      timestamptz,
  -- derived from the user's OWN outgoing texts; drives voice mirroring
  style_profile       jsonb not null default '{}'::jsonb,

  -- inbound debounce + turn locking
  pending_turn_at     timestamptz,
  turn_locked_at      timestamptz,

  last_inbound_at     timestamptz,
  last_outbound_at    timestamptz,

  -- proactive send budget
  proactive_sent_today int not null default 0,
  budget_day          date,

  quiet_hours_start   int not null default 22,            -- local hour, inclusive
  quiet_hours_end     int not null default 8,             -- local hour, exclusive

  opted_out           boolean not null default false,
  created_at          timestamptz not null default now()
);

create index if not exists users_pending_turn_idx on users (pending_turn_at)
  where pending_turn_at is not null;

create table if not exists messages (
  id           bigserial primary key,
  user_id      uuid not null references users(id) on delete cascade,
  direction    text not null,                             -- 'in' | 'out'
  body         text not null,
  provider_id  text,
  proactive    boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists messages_user_time_idx on messages (user_id, created_at desc);

create table if not exists goals (
  id               bigserial primary key,
  user_id          uuid not null references users(id) on delete cascade,
  title            text not null,
  why              text,
  cadence          text,                                   -- free text: 'daily', '3x a week'
  target_date      date,
  status           text not null default 'active',         -- active | done | paused | dropped
  last_progress_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists goals_user_idx on goals (user_id, status);

create table if not exists checkins (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  goal_id    bigint references goals(id) on delete set null,
  note       text not null,
  sentiment  text,                                         -- good | mixed | rough
  created_at timestamptz not null default now()
);
create index if not exists checkins_user_time_idx on checkins (user_id, created_at desc);

-- memory layer 2: structured entities the agent can reference by name
create table if not exists facts (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  kind       text not null,                                -- person | preference | context | detail
  key        text not null,
  value      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind, key)
);

create table if not exists scheduled_messages (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  run_at     timestamptz not null,
  intent     text not null,                                -- what the agent wanted to say/do
  source     text not null default 'agent',                -- agent | sweep
  status     text not null default 'pending',              -- pending | sent | skipped | canceled
  locked_at  timestamptz,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists sched_due_idx on scheduled_messages (run_at)
  where status = 'pending';

-- webhook idempotency (Stripe + channel providers both retry)
create table if not exists processed_events (
  id         text primary key,
  created_at timestamptz not null default now()
);
