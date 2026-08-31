import { google } from "googleapis";
import { config } from "../config.js";
import { sql, type User } from "../db/index.js";

export function oauthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    `${config.publicBaseUrl}/connect/google/callback`,
  );
}

export function consentUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token on re-auth
    scope: config.google.scopes,
    state,
  });
}

function calendarFor(user: User) {
  const client = oauthClient();
  client.setCredentials({ refresh_token: user.google_refresh_token! });
  return google.calendar({ version: "v3", auth: client });
}

async function dropTokenAndThrow(userId: string, err: unknown): Promise<never> {
  // A revoked grant looks like a 400/401 here. Clear it so the agent stops
  // believing it has calendar access and can re-ask.
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 400 || status === 401) {
    await sql`update users set google_refresh_token = null where id = ${userId}`;
    throw new Error("calendar access was revoked");
  }
  throw err;
}

export async function listUpcoming(user: User, days: number) {
  if (!user.google_refresh_token) return null;
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400000);
  try {
    const res = await calendarFor(user).events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 25,
    });
    return (res.data.items ?? []).map((e) => ({
      title: e.summary ?? "(untitled)",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
    }));
  } catch (err) {
    return dropTokenAndThrow(user.id, err);
  }
}

export async function createEvent(
  user: User,
  input: { title: string; startIso: string; endIso: string; notes?: string },
) {
  if (!user.google_refresh_token) return null;
  try {
    const res = await calendarFor(user).events.insert({
      calendarId: "primary",
      requestBody: {
        summary: input.title,
        description: input.notes,
        start: { dateTime: input.startIso, timeZone: user.timezone },
        end: { dateTime: input.endIso, timeZone: user.timezone },
      },
    });
    return { id: res.data.id ?? "", link: res.data.htmlLink ?? "" };
  } catch (err) {
    return dropTokenAndThrow(user.id, err);
  }
}
