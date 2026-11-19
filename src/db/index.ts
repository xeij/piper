import postgres from "postgres";
import { config } from "../config.js";

export const sql = postgres(config.databaseUrl, {
  max: 10,
  transform: { undefined: null },
});

export type User = {
  id: string;
  phone: string;
  channel: "imessage" | "sms";
  display_name: string | null;
  timezone: string;
  onboarding_stage: "new" | "discovering" | "calendar_pitched" | "paywalled" | "active";
  subscription_status: "none" | "trialing" | "active" | "past_due" | "canceled";
  trial_ends_at: Date | null;
  stripe_customer_id: string | null;
  google_refresh_token: string | null;
  calendar_feed_seen_at: Date | null;
  profile_doc: string;
  profile_doc_at: Date | null;
  style_profile: StyleProfile;
  pending_turn_at: Date | null;
  turn_locked_at: Date | null;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  proactive_sent_today: number;
  budget_day: string | null;
  quiet_hours_start: number;
  quiet_hours_end: number;
  opted_out: boolean;
  created_at: Date;
};

export type StyleProfile = {
  medianLength?: number;
  lowercaseRate?: number;
  emojiRate?: number;
  topEmoji?: string[];
  endsWithPeriodRate?: number;
  abbreviations?: string[];
  samples?: string[];
};

export type Goal = {
  id: number;
  user_id: string;
  title: string;
  why: string | null;
  cadence: string | null;
  target_date: string | null;
  status: "active" | "done" | "paused" | "dropped";
  last_progress_at: Date | null;
};

export type Fact = { id: number; kind: string; key: string; value: string };
