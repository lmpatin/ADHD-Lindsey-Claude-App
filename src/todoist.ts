// Todoist: read-only access through the unified API v1.
// https://developer.todoist.com/api/v1/

import { extractLinks, plainText, type LinkChip } from "./links";
import { addDays, daysBetween, localDate, monthDay, shortDay } from "./time";

const API = "https://api.todoist.com/api/v1";

export const LOCATION_LABELS = ["Computer", "Upstairs", "Downstairs"] as const;
export const FLEXIBLE_LABEL = "Flexible Date";
export const STREAK_LABEL = "✅_streak";

/** The fields of a v1 task this app reads. */
export interface RawTask {
  id: string;
  content: string;
  description?: string;
  project_id?: string;
  labels?: string[];
  priority?: number; // 4 = p1 (highest) … 1 = p4
  due?: {
    date: string; // "YYYY-MM-DD", floating "YYYY-MM-DDTHH:MM:SS", or UTC "…Z"
    datetime?: string | null;
    timezone?: string | null;
    is_recurring?: boolean;
    string?: string;
  } | null;
  duration?: { amount: number; unit: "minute" | "day" } | null;
  added_at?: string;
  created_at?: string;
  url?: string;
  checked?: boolean;
  is_deleted?: boolean;
}

export interface RawComment {
  id: string;
  content: string;
  posted_at: string;
}

interface Page<T> {
  results: T[];
  next_cursor: string | null;
}

async function getJson<T>(token: string, path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Todoist ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function getAll<T>(token: string, path: string, params: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  // A hard page cap guards against a cursor loop; 50 × 200 is far more than one person has.
  for (let i = 0; i < 50; i++) {
    const page: Page<T> = await getJson<Page<T>>(token, path, {
      ...params,
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    out.push(...page.results);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return out;
}

export interface TodoistSnapshot {
  tasks: RawTask[];
  projects: Record<string, string>;
  /** Newest "Followed up" comment date (YYYY-MM-DD, local) per (w) task id. */
  followedUp: Record<string, string | null>;
}

/** Fetches everything Phase 1 needs from Todoist. */
export async function fetchTodoist(token: string, tz: string): Promise<TodoistSnapshot> {
  const [tasks, projects] = await Promise.all([
    getAll<RawTask>(token, "/tasks"),
    getAll<{ id: string; name: string }>(token, "/projects"),
  ]);
  const active = tasks.filter((t) => !t.checked && !t.is_deleted);

  const waiting = active.filter((t) => isWaiting(t.content));
  const followedUp: Record<string, string | null> = {};
  await Promise.all(
    waiting.map(async (t) => {
      const comments = await getAll<RawComment>(token, "/comments", { task_id: t.id });
      followedUp[t.id] = latestFollowUp(comments, tz);
    }),
  );

  return {
    tasks: active,
    projects: Object.fromEntries(projects.map((p) => [p.id, p.name])),
    followedUp,
  };
}

/** Local date of the newest comment that starts "Followed up", or null. */
export function latestFollowUp(comments: RawComment[], tz: string): string | null {
  let newest: string | null = null;
  for (const c of comments) {
    if (!/^\s*followed up/i.test(c.content)) continue;
    if (!newest || c.posted_at > newest) newest = c.posted_at;
  }
  return newest ? localDate(new Date(newest), tz) : null;
}

const WAITING_PREFIX = /^\s*\(w\)\s*/i;

export function isWaiting(content: string): boolean {
  return WAITING_PREFIX.test(content);
}

/** The task's due date as a local "YYYY-MM-DD", or null. */
export function dueDate(task: RawTask, tz: string): string | null {
  const d = task.due;
  if (!d) return null;
  const raw = d.datetime || d.date;
  if (!raw) return null;
  // UTC timestamps belong to whatever local day they fall on; floating ones are already local.
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(raw)) return localDate(new Date(raw), tz);
  return raw.slice(0, 10);
}

/** "HH:MM" local due time, or null for date-only tasks. */
export function dueTime(task: RawTask, tz: string): string | null {
  const raw = task.due?.datetime || task.due?.date;
  if (!raw || raw.length <= 10) return null;
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(raw)) {
    const t = new Date(raw);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    }).format(t);
    return parts;
  }
  const [h, m] = raw.slice(11, 16).split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function taskUrl(task: RawTask): string {
  return task.url || `https://app.todoist.com/app/task/${task.id}`;
}

export interface TaskView {
  id: string;
  title: string;
  description: string;
  project: string | null;
  labels: string[];
  location: string;
  priority: number; // 1 = p1 (highest) … 4 = p4, as Todoist shows it
  due_date: string | null;
  due_time: string | null;
  overdue: boolean;
  flexible: boolean;
  duration_minutes: number | null;
  links: LinkChip[];
  todoist_url: string;
}

function toView(task: RawTask, snap: TodoistSnapshot, today: string, tz: string): TaskView {
  const labels = task.labels ?? [];
  const due = dueDate(task, tz);
  const content = task.content.replace(WAITING_PREFIX, "");
  const d = task.duration;
  return {
    id: task.id,
    title: plainText(content),
    description: plainText(task.description),
    project: (task.project_id && snap.projects[task.project_id]) || null,
    labels,
    location: LOCATION_LABELS.find((l) => labels.includes(l)) ?? "Anywhere",
    priority: 5 - (task.priority ?? 1),
    due_date: due,
    due_time: dueTime(task, tz),
    overdue: due !== null && due < today,
    flexible: labels.includes(FLEXIBLE_LABEL),
    duration_minutes: d ? (d.unit === "day" ? d.amount * 1440 : d.amount) : null,
    links: extractLinks(task.content, task.description),
    todoist_url: taskUrl(task),
  };
}

export interface TaskGroup {
  location: string;
  tasks: TaskView[];
}

/**
 * Today's candidate tasks: `today | overdue` plus anything labelled
 * Flexible Date, minus streak routines and (w) items, grouped by location.
 */
export function candidateTasks(snap: TodoistSnapshot, now: Date, tz: string): TaskGroup[] {
  const today = localDate(now, tz);
  const picked = snap.tasks.filter((t) => {
    const labels = t.labels ?? [];
    if (labels.includes(STREAK_LABEL) || isWaiting(t.content)) return false;
    const due = dueDate(t, tz);
    return (due !== null && due <= today) || labels.includes(FLEXIBLE_LABEL);
  });

  const views = picked.map((t) => toView(t, snap, today, tz));
  views.sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      a.priority - b.priority ||
      Number(a.flexible) - Number(b.flexible) ||
      (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
      a.title.localeCompare(b.title),
  );

  const order = [...LOCATION_LABELS, "Anywhere"];
  return order
    .map((location) => ({ location, tasks: views.filter((v) => v.location === location) }))
    .filter((g) => g.tasks.length > 0);
}

export interface WaitingView extends TaskView {
  waiting_days: number | null;
  nudged: string | null; // "Oct 16"
  check_label: string | null; // "Thu 22", "Tomorrow"
  meta: string; // "Waiting 6 days · nudged Oct 16"
}

export interface WaitingLists {
  check_today: WaitingView[];
  coming_up: WaitingView[];
}

export function waitingLists(snap: TodoistSnapshot, now: Date, tz: string): WaitingLists {
  const today = localDate(now, tz);
  const tomorrow = addDays(today, 1);
  const items: WaitingView[] = snap.tasks
    .filter((t) => isWaiting(t.content))
    .map((t) => {
      const view = toView(t, snap, today, tz);
      const created = t.added_at || t.created_at;
      const waitingDays = created ? Math.max(0, daysBetween(localDate(new Date(created), tz), today)) : null;
      const nudgedDate = snap.followedUp[t.id] ?? null;
      const nudged = nudgedDate ? monthDay(nudgedDate) : null;
      const parts: string[] = [];
      if (waitingDays !== null) parts.push(`Waiting ${waitingDays} ${waitingDays === 1 ? "day" : "days"}`);
      parts.push(nudged ? `nudged ${nudged}` : "not nudged yet");
      const due = view.due_date;
      return {
        ...view,
        waiting_days: waitingDays,
        nudged,
        check_label: due === null ? null : due === tomorrow ? "Tomorrow" : shortDay(due),
        meta: parts.join(" · "),
      };
    });

  const check_today = items
    .filter((i) => i.due_date !== null && i.due_date <= today)
    .sort((a, b) => (b.waiting_days ?? 0) - (a.waiting_days ?? 0) || a.title.localeCompare(b.title));
  const coming_up = items
    .filter((i) => i.due_date === null || i.due_date > today)
    .sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"));
  return { check_today, coming_up };
}
