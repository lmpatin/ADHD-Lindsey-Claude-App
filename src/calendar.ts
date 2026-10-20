// Google Calendar: read-only OAuth and event fetching for the primary calendar.

import { extractLinks, knownService, type LinkChip } from "./links";
import { addDays, localDate, startOfLocalDay, zonedInstant } from "./time";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** How far into tomorrow "tomorrow morning" reaches (local hour). */
const TOMORROW_MORNING_END_HOUR = 12;

export interface RawEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  transparency?: "opaque" | "transparent";
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string; label?: string }[];
  };
}

export function consentUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", CALENDAR_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
): Promise<{ refresh_token?: string; access_token: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

let cachedAccess: { token: string; expires: number; refresh: string } | null = null;

async function accessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  if (cachedAccess && cachedAccess.refresh === refreshToken && cachedAccess.expires > Date.now() + 60_000) {
    return cachedAccess.token;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccess = { token: json.access_token, expires: Date.now() + json.expires_in * 1000, refresh: refreshToken };
  return json.access_token;
}

/** Today's events plus tomorrow morning's, from the primary calendar. */
export async function fetchEvents(
  creds: { clientId: string; clientSecret: string; refreshToken: string },
  now: Date,
  tz: string,
): Promise<RawEvent[]> {
  const token = await accessToken(creds.clientId, creds.clientSecret, creds.refreshToken);
  const today = localDate(now, tz);
  const [y, m, d] = addDays(today, 1).split("-").map(Number);
  const u = new URL(EVENTS_URL);
  u.searchParams.set("timeMin", startOfLocalDay(today, tz).toISOString());
  u.searchParams.set("timeMax", zonedInstant(y, m, d, TOMORROW_MORNING_END_HOUR, 0, tz).toISOString());
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("maxResults", "250");
  u.searchParams.set("timeZone", tz);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google Calendar failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { items?: RawEvent[] };
  return json.items ?? [];
}

export interface Anchor {
  id: string;
  title: string;
  start: string; // ISO instant
  end: string | null;
  location: string | null;
  join_url: string | null;
  join_label: string | null;
  agenda_url: string | null;
  links: LinkChip[]; // other description links
  event_url: string | null;
  response: string | null;
  with_others: boolean;
}

export type AnchorRule = "busy" | "people_or_place";

function selfResponse(e: RawEvent): string | null {
  return e.attendees?.find((a) => a.self)?.responseStatus ?? null;
}

function hasOthers(e: RawEvent): boolean {
  return (e.attendees ?? []).some((a) => !a.self && !a.resource);
}

/**
 * Whether an event is an anchor: timed, not cancelled or declined, and busy.
 * Under the stricter "people_or_place" rule it must also involve someone
 * else, a place or a video call.
 */
export function isAnchor(e: RawEvent, rule: AnchorRule = "busy"): boolean {
  if (e.status === "cancelled") return false;
  if (!e.start?.dateTime) return false; // all-day
  if (e.transparency === "transparent") return false; // shows as free
  if (e.eventType === "workingLocation" || e.eventType === "outOfOffice") return false;
  if (selfResponse(e) === "declined") return false;
  if (rule === "people_or_place") {
    return hasOthers(e) || !!e.location?.trim() || !!joinLink(e);
  }
  return true;
}

/** Meet link, then a video entry point, then a Zoom/Teams URL in location or description. */
export function joinLink(e: RawEvent): LinkChip | null {
  if (e.hangoutLink) return { url: e.hangoutLink, label: "Join Meet" };
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video" && p.uri);
  if (video?.uri) return { url: video.uri, label: `Join ${knownService(video.uri) ?? "call"}` };
  for (const link of extractLinks(e.location, e.description)) {
    const svc = knownService(link.url);
    if (svc === "Zoom" || svc === "Teams" || svc === "Meet") return { url: link.url, label: `Join ${svc}` };
  }
  return null;
}

export function toAnchor(e: RawEvent): Anchor {
  const join = joinLink(e);
  const descLinks = extractLinks(e.description);
  const agenda = descLinks.find((l) => {
    const svc = knownService(l.url);
    return svc !== null && (svc.startsWith("Google ") || svc === "Notion") && svc !== "Google Form";
  });
  const extras = descLinks.filter((l) => l.url !== join?.url && l.url !== agenda?.url);
  return {
    id: e.id,
    title: e.summary?.trim() || "(No title)",
    start: new Date(e.start!.dateTime!).toISOString(),
    end: e.end?.dateTime ? new Date(e.end.dateTime).toISOString() : null,
    location: e.location?.trim() || null,
    join_url: join?.url ?? null,
    join_label: join?.label ?? null,
    agenda_url: agenda?.url ?? null,
    links: extras,
    event_url: e.htmlLink ?? null,
    response: selfResponse(e),
    with_others: hasOthers(e),
  };
}

export interface AnchorPlan {
  next: Anchor | null;
  current: Anchor | null; // an anchor in progress right now, if any
  last_ended: Anchor | null; // the latest anchor that has already finished
  later_today: Anchor[]; // anchors today after `next`
}

export function planAnchors(events: RawEvent[], now: Date, tz: string, rule: AnchorRule = "busy"): AnchorPlan {
  const anchors = events
    .filter((e) => isAnchor(e, rule))
    .map(toAnchor)
    .sort((a, b) => a.start.localeCompare(b.start));
  const nowMs = now.getTime();
  const upcoming = anchors.filter((a) => Date.parse(a.start) > nowMs);
  const current =
    anchors.find((a) => Date.parse(a.start) <= nowMs && a.end !== null && Date.parse(a.end) > nowMs) ?? null;
  const ended = anchors.filter((a) => a.end !== null && Date.parse(a.end) <= nowMs);
  const last_ended = ended.sort((a, b) => a.end!.localeCompare(b.end!)).at(-1) ?? null;
  const today = localDate(now, tz);
  const next = upcoming[0] ?? null;
  return {
    next,
    current,
    last_ended,
    later_today: upcoming.slice(1).filter((a) => localDate(new Date(a.start), tz) === today),
  };
}
