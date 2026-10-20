import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/worker";

const NOW = new Date("2026-10-20T20:20:00Z"); // 1:20 PM PDT

class MemoryKV {
  data = new Map<string, string>();
  async get(key: string, type?: string) {
    const v = this.data.get(key) ?? null;
    return v !== null && type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
}

function makeEnv(kv = new MemoryKV()): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    NOW_KV: kv as unknown as KVNamespace,
    TIMEZONE: "America/Los_Angeles",
    MEALTIMES: "08:00,12:30,18:30",
    DEV_SKIP_ACCESS: "true",
    TODOIST_TOKEN: "todoist",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "refresh",
    FEED_TOKEN: "feed-secret",
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

export const TASKS = [
  { id: "1", content: "Draft renewal email to [Dana](https://mail.google.com/mail/u/0/#inbox/FMfc)", description: "Pricing sheet: https://docs.google.com/spreadsheets/d/abc/edit", labels: ["Computer"], priority: 4, project_id: "work", due: { date: "2026-10-20" }, added_at: "2026-10-19T16:00:00Z" },
  { id: "2", content: "Update opportunity notes", description: "https://acme.lightning.force.com/lightning/r/Opportunity/006/view", labels: ["Computer"], priority: 2, project_id: "work", due: { date: "2026-10-19" }, added_at: "2026-10-12T16:00:00Z" },
  { id: "3", content: "Swap laundry", description: "", labels: ["Downstairs", "Flexible Date"], priority: 1, project_id: "home", due: null, added_at: "2026-10-18T16:00:00Z" },
  { id: "4", content: "Water plants", description: "", labels: ["Upstairs"], priority: 1, project_id: "home", due: { date: "2026-10-20T17:00:00" }, duration: { amount: 10, unit: "minute" }, added_at: "2026-10-18T16:00:00Z" },
  { id: "5", content: "Morning pages", description: "", labels: ["✅_streak"], priority: 1, project_id: "home", due: { date: "2026-10-20", is_recurring: true }, added_at: "2026-01-01T16:00:00Z" },
  { id: "6", content: "Read Shadow Ledger notes", description: "[Ledger hub](https://www.notion.so/Ledger-hub-abc)", labels: ["Flexible Date"], priority: 1, project_id: "ledger", due: null, added_at: "2026-10-01T16:00:00Z" },
  { id: "w1", content: "(w) District IT — SSO test credentials", description: "Thread: https://mail.google.com/mail/u/0/#inbox/QgrcJ", labels: [], priority: 1, project_id: "work", due: { date: "2026-10-20" }, added_at: "2026-10-14T16:00:00Z" },
  { id: "w2", content: "(w) Refund for reformer part", description: "", labels: [], priority: 1, project_id: "home", due: { date: "2026-10-18" }, added_at: "2026-10-11T16:00:00Z" },
  { id: "w3", content: "(w) Procurement redlines on renewal", description: "", labels: [], priority: 1, project_id: "work", due: { date: "2026-10-22" }, added_at: "2026-10-17T16:00:00Z" },
  { id: "w4", content: "(w) Furnace tune-up quote", description: "", labels: [], priority: 1, project_id: "home", due: { date: "2026-10-29" }, added_at: "2026-10-19T16:00:00Z" },
];

const EVENTS = [
  { id: "e1", summary: "Standup", start: { dateTime: "2026-10-20T09:00:00-07:00" }, end: { dateTime: "2026-10-20T09:15:00-07:00" } },
  { id: "e2", summary: "Lunch", start: { dateTime: "2026-10-20T12:00:00-07:00" }, end: { dateTime: "2026-10-20T13:00:00-07:00" } },
  { id: "e3", summary: "Focus time", transparency: "transparent", start: { dateTime: "2026-10-20T14:00:00-07:00" }, end: { dateTime: "2026-10-20T14:30:00-07:00" } },
  {
    id: "e4",
    summary: "Customer demo · district SIS",
    start: { dateTime: "2026-10-20T15:00:00-07:00" },
    end: { dateTime: "2026-10-20T16:00:00-07:00" },
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    description: 'Agenda: <a href="https://docs.google.com/document/d/agenda/edit">Demo agenda</a>',
    attendees: [{ self: true, responseStatus: "accepted" }, { email: "it@district.org", responseStatus: "accepted" }],
  },
  { id: "e5", summary: "Pickup", start: { dateTime: "2026-10-20T17:30:00-07:00" }, end: { dateTime: "2026-10-20T18:00:00-07:00" } },
  { id: "e6", summary: "What did you avoid today?", start: { dateTime: "2026-10-20T20:00:00-07:00" }, end: { dateTime: "2026-10-20T20:15:00-07:00" } },
  { id: "e7", summary: "Holiday", start: { date: "2026-10-20" }, end: { date: "2026-10-21" } },
];

function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  if (url.hostname === "api.todoist.com") {
    if (url.pathname === "/api/v1/tasks") return ok({ results: TASKS, next_cursor: null });
    if (url.pathname === "/api/v1/projects")
      return ok({ results: [{ id: "work", name: "Work" }, { id: "home", name: "Home" }, { id: "ledger", name: "Shadow Ledger" }], next_cursor: null });
    if (url.pathname === "/api/v1/comments") {
      const id = url.searchParams.get("task_id");
      const results = id === "w1" ? [{ id: "c1", content: "Followed up by email", posted_at: "2026-10-16T18:00:00Z" }] : [];
      return ok({ results, next_cursor: null });
    }
  }
  if (url.hostname === "oauth2.googleapis.com") return ok({ access_token: "at", expires_in: 3600 });
  if (url.hostname === "www.googleapis.com") return ok({ items: EVENTS });
  return Promise.resolve(new Response("unexpected " + url, { status: 500 }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const call = (env: Env, path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://now.example.com${path}`, init), env, ctx);

describe("worker", () => {
  it("serves the state the web app renders", async () => {
    const res = await call(makeEnv(), "/api/state?fresh=1");
    expect(res.status).toBe(200);
    const s = (await res.json()) as any;
    expect(s.errors).toEqual({});
    expect(s.next_anchor.title).toBe("Customer demo · district SIS");
    expect(s.next_anchor.join_url).toBe("https://meet.google.com/abc-defg-hij");
    expect(s.next_anchor.agenda_url).toBe("https://docs.google.com/document/d/agenda/edit");
    expect(s.later_today.map((a: any) => a.title)).toEqual(["Pickup", "What did you avoid today?"]);
    expect(s.tasks.map((g: any) => g.location)).toEqual(["Computer", "Upstairs", "Downstairs", "Anywhere"]);
    expect(s.waiting.check_today.map((t: any) => t.id)).toEqual(["w2", "w1"]);
    expect(s.waiting.coming_up.map((t: any) => t.check_label)).toEqual(["Thu 22", "Thu 29"]);
    expect(s.block.checks.map((c: any) => c.key)).toEqual(["water", "move"]);
    if (process.env.WRITE_FIXTURE) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.WRITE_FIXTURE, JSON.stringify(s, null, 2));
    }
  });

  it("returns the /api/now feed shape and rejects a wrong token", async () => {
    const env = makeEnv();
    expect((await call(env, "/api/now?token=nope")).status).toBe(401);
    expect((await call(env, "/api/now")).status).toBe(401);

    await call(env, "/api/mode", { method: "POST", body: JSON.stringify({ mode: "Admin" }) });
    const res = await call(env, "/api/now?token=feed-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      generated_at: "2026-10-20T13:20:00-07:00",
      mode: "Admin",
      line1: "3:00 Customer demo · district SIS · 1h 40m free",
      line2: "2 checks due · water, move",
      next_anchor: {
        title: "Customer demo · district SIS",
        start: "2026-10-20T15:00:00-07:00",
        join_url: "https://meet.google.com/abc-defg-hij",
      },
      minutes_free: 100,
      waiting_due_count: 2,
      body_due: ["water", "move"],
    });
  });

  it("saves body checks per block in KV", async () => {
    const env = makeEnv();
    const s = (await (await call(env, "/api/state")).json()) as any;
    const r = await call(env, "/api/body", {
      method: "POST",
      body: JSON.stringify({ block: s.block.key, item: "water", done: true }),
    });
    expect(r.status).toBe(200);
    const feed = (await (await call(env, "/api/now?token=feed-secret")).json()) as any;
    expect(feed.body_due).toEqual(["move"]);
  });

  it("rejects invalid writes", async () => {
    const env = makeEnv();
    expect((await call(env, "/api/mode", { method: "POST", body: JSON.stringify({ mode: "Party" }) })).status).toBe(400);
    expect((await call(env, "/api/body", { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("blocks everything but the feed without Cloudflare Access", async () => {
    const env = { ...makeEnv(), DEV_SKIP_ACCESS: undefined, ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com", ACCESS_AUD: "aud" };
    expect((await call(env, "/")).status).toBe(403);
    expect((await call(env, "/api/state")).status).toBe(403);
    expect((await call(env, "/auth/google")).status).toBe(403);
    expect((await call(env, "/api/now?token=feed-secret")).status).toBe(200);
  });

  it("never writes to Todoist or Google", async () => {
    const env = makeEnv();
    await call(env, "/api/state?fresh=1");
    await call(env, "/api/mode", { method: "POST", body: JSON.stringify({ mode: "Deep" }) });
    const methods = (fetch as any).mock.calls.map(([input, init]: [any, any]) => {
      const host = new URL(typeof input === "string" ? input : input.url ?? input.href).hostname;
      return `${init?.method ?? "GET"} ${host}`;
    });
    expect(methods.filter((m: string) => m.startsWith("POST") && !m.endsWith("oauth2.googleapis.com"))).toEqual([]);
  });
});
