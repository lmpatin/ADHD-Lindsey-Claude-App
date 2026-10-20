// Now app — Phase 1. One Worker serves the web app (from ./public) and its API.
// Everything is read-only against Todoist and Google Calendar.

import { safeEqual, verifyAccess } from "./access";
import {
  bodyChecks,
  crossesMealtime,
  currentBlock,
  MODES,
  parseMealtimes,
  readBody,
  readMode,
  writeBody,
  writeMode,
  BODY_ITEMS,
  type BodyKey,
  type Mode,
} from "./body";
import { consentUrl, exchangeCode, fetchEvents, planAnchors, type AnchorRule, type RawEvent } from "./calendar";
import { formatDuration, isoLocal, localDate, shortClock } from "./time";
import { candidateTasks, fetchTodoist, waitingLists, type TodoistSnapshot } from "./todoist";

export interface Env {
  ASSETS: Fetcher;
  NOW_KV: KVNamespace;
  // vars
  TIMEZONE: string;
  MEALTIMES?: string;
  ANCHOR_RULE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAIL?: string;
  /** Local development only: skip the Access check. Never set in production. */
  DEV_SKIP_ACCESS?: string;
  // secrets
  TODOIST_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN?: string;
  FEED_TOKEN: string;
}

const CACHE_TTL_SECONDS = 60;
const REFRESH_TOKEN_KV_KEY = "google:refresh_token";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      // The feed is the one route outside Cloudflare Access; it checks its own token.
      if (url.pathname === "/api/now") return await handleFeed(request, env, ctx);

      if (!(await isSignedIn(request, env))) {
        return new Response("Not signed in. Open this app through its Cloudflare Access URL.", { status: 403 });
      }

      if (url.pathname === "/api/state" && request.method === "GET") {
        return json(await buildState(env, ctx, url.searchParams.has("fresh")));
      }
      if (url.pathname === "/api/mode" && request.method === "POST") return await handleMode(request, env);
      if (url.pathname === "/api/body" && request.method === "POST") return await handleBody(request, env);
      if (url.pathname === "/auth/google") return handleAuthStart(request, env);
      if (url.pathname === "/auth/google/callback") return await handleAuthCallback(request, env);
      if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function isSignedIn(request: Request, env: Env): Promise<boolean> {
  if (env.DEV_SKIP_ACCESS === "true") return true;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  const email = await verifyAccess(request, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
    allowedEmail: env.ALLOWED_EMAIL,
  });
  return email !== null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---- Cached upstream reads ---------------------------------------------

const memo = new Map<string, { at: number; value: unknown }>();

/**
 * 60-second cache in front of Todoist and Google: an in-memory copy for the
 * current isolate, backed by the Cache API (which works on custom domains;
 * on workers.dev it is a no-op and the in-memory copy carries the load).
 */
async function cached<T>(key: string, ctx: ExecutionContext, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_SECONDS * 1000) return hit.value as T;

  const cacheKey = new Request(`https://now-app.cache/${encodeURIComponent(key)}`);
  const cache = caches.default;
  if (!fresh) {
    const res = await cache.match(cacheKey);
    if (res) {
      const value = (await res.json()) as T;
      memo.set(key, { at: Date.now(), value });
      return value;
    }
  }
  const value = await load();
  memo.set(key, { at: Date.now(), value });
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_TTL_SECONDS}` },
      }),
    ),
  );
  return value;
}

async function refreshToken(env: Env): Promise<string | null> {
  return env.GOOGLE_REFRESH_TOKEN || (await env.NOW_KV.get(REFRESH_TOKEN_KV_KEY));
}

// ---- State -----------------------------------------------------------------

async function buildState(env: Env, ctx: ExecutionContext, fresh: boolean) {
  const tz = env.TIMEZONE || "America/Los_Angeles";
  const now = new Date();
  const today = localDate(now, tz);
  const errors: Record<string, string> = {};

  const [snap, events, mode] = await Promise.all([
    cached<TodoistSnapshot>(`todoist:${today}`, ctx, fresh, () => fetchTodoist(env.TODOIST_TOKEN, tz)).catch(
      (e: Error) => {
        errors.todoist = e.message;
        return null;
      },
    ),
    (async () => {
      const refresh = await refreshToken(env);
      if (!refresh) {
        errors.calendar = "Google Calendar isn't connected yet. Visit /auth/google once.";
        return null;
      }
      return cached<RawEvent[]>(`calendar:${today}`, ctx, fresh, () =>
        fetchEvents(
          { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: refresh },
          now,
          tz,
        ),
      );
    })().catch((e: Error) => {
      errors.calendar = e.message;
      return null;
    }),
    readMode(env.NOW_KV, today),
  ]);

  const rule: AnchorRule = env.ANCHOR_RULE === "people_or_place" ? "people_or_place" : "busy";
  const anchors = planAnchors(events ?? [], now, tz, rule);
  const block = currentBlock(anchors.next, anchors.last_ended, now, tz);
  const showFood = crossesMealtime(block, parseMealtimes(env.MEALTIMES), tz);
  const checks = bodyChecks(showFood, await readBody(env.NOW_KV, block.key));
  const waiting = snap ? waitingLists(snap, now, tz) : { check_today: [], coming_up: [] };

  return {
    generated_at: isoLocal(now, tz),
    timezone: tz,
    today,
    mode,
    modes: MODES,
    next_anchor: anchors.next,
    current_anchor: anchors.current,
    later_today: anchors.later_today,
    block: { key: block.key, start: block.start.toISOString(), end: block.end.toISOString(), checks },
    tasks: snap ? candidateTasks(snap, now, tz) : [],
    waiting,
    errors,
  };
}

// ---- Feed ------------------------------------------------------------------

const FEED_WORDS: Record<BodyKey, string> = { water: "water", eat: "eat", move: "move" };

async function handleFeed(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!env.FEED_TOKEN || !safeEqual(token, env.FEED_TOKEN)) return json({ error: "Invalid token" }, 401);

  const s = await buildState(env, ctx, false);
  const tz = s.timezone;
  const now = new Date();
  const next = s.next_anchor;
  const minutesFree = next ? Math.max(0, Math.round((Date.parse(next.start) - now.getTime()) / 60000)) : null;

  let line1 = "No more anchors today";
  if (next) {
    const start = new Date(next.start);
    const isToday = localDate(start, tz) === s.today;
    line1 = isToday
      ? `${shortClock(start, tz)} ${next.title} · ${formatDuration(minutesFree!)} free`
      : `Tomorrow ${shortClock(start, tz)} ${next.title}`;
  }

  const due = s.waiting.check_today.length;
  const bodyDue = s.block.checks.filter((c) => !c.done).map((c) => FEED_WORDS[c.key]);
  const parts: string[] = [];
  if (due > 0) parts.push(`${due} ${due === 1 ? "check" : "checks"} due`);
  if (bodyDue.length) parts.push(bodyDue.join(", "));
  const line2 = parts.length ? parts.join(" · ") : "Nothing due";

  return json({
    generated_at: s.generated_at,
    mode: s.mode,
    line1,
    line2,
    next_anchor: next ? { title: next.title, start: isoLocal(new Date(next.start), tz), join_url: next.join_url } : null,
    minutes_free: minutesFree,
    waiting_due_count: due,
    body_due: bodyDue,
  });
}

// ---- Writes to KV (never to Todoist or Calendar) ---------------------------

async function handleMode(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { mode?: string };
  if (!body.mode || !(MODES as readonly string[]).includes(body.mode)) {
    return json({ error: `mode must be one of ${MODES.join(", ")}` }, 400);
  }
  const today = localDate(new Date(), env.TIMEZONE || "America/Los_Angeles");
  await writeMode(env.NOW_KV, today, body.mode as Mode);
  return json({ ok: true, mode: body.mode });
}

async function handleBody(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { block?: string; item?: string; done?: boolean };
  const valid = BODY_ITEMS.some((i) => i.key === body.item);
  if (!body.block || !valid || typeof body.done !== "boolean") {
    return json({ error: "Expected { block, item, done }" }, 400);
  }
  const state = await readBody(env.NOW_KV, body.block);
  state[body.item as BodyKey] = body.done;
  await writeBody(env.NOW_KV, body.block, state);
  return json({ ok: true, state });
}

// ---- Google consent (one time) ---------------------------------------------

function redirectUri(request: Request): string {
  return `${new URL(request.url).origin}/auth/google/callback`;
}

function handleAuthStart(request: Request, env: Env): Response {
  const state = crypto.randomUUID();
  return new Response(null, {
    status: 302,
    headers: {
      Location: consentUrl(env.GOOGLE_CLIENT_ID, redirectUri(request), state),
      "Set-Cookie": `g_state=${state}; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

async function handleAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cookieState = request.headers
    .get("Cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith("g_state="))
    ?.slice("g_state=".length);
  const state = url.searchParams.get("state");
  if (!state || !cookieState || !safeEqual(state, cookieState)) {
    return page("Sign-in expired", "Start again at <a href=\"/auth/google\">/auth/google</a>.", 400);
  }
  const error = url.searchParams.get("error");
  if (error) return page("Google said no", `Google returned: ${escapeHtml(error)}.`, 400);
  const code = url.searchParams.get("code");
  if (!code) return page("Missing code", "Google didn't send a code back.", 400);

  const tokens = await exchangeCode(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirectUri(request), code);
  if (!tokens.refresh_token) {
    return page(
      "No refresh token",
      "Google didn't issue a refresh token. Remove the app's access at myaccount.google.com/permissions, then visit <a href=\"/auth/google\">/auth/google</a> again.",
      400,
    );
  }
  // Kept server-side in KV, never shown in the browser.
  await env.NOW_KV.put(REFRESH_TOKEN_KV_KEY, tokens.refresh_token);
  return page("Calendar connected", 'Google Calendar is connected (read-only). <a href="/">Open Now</a>.');
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title>` +
      `<body style="background:#181715;color:#EDE7DC;font-family:system-ui,sans-serif;padding:32px;line-height:1.5">` +
      `<h1 style="font-size:22px">${escapeHtml(title)}</h1><p>${body}</p>` +
      `<style>a{color:#C9DBB8}</style></body>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "g_state=; Path=/auth/google; Max-Age=0",
      },
    },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
