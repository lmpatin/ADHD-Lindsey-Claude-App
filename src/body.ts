// Body checks (water, food, movement) and today's mode. Both live in KV so
// the /api/now feed can read them; nothing here touches Todoist or Calendar.

import type { Anchor } from "./calendar";
import { localDate, localParts, zonedInstant } from "./time";

export const MODES = ["Admin", "Deep", "Up & About"] as const;
export type Mode = (typeof MODES)[number];

export const BODY_ITEMS = [
  { key: "water", label: "Water" },
  { key: "eat", label: "Eat something" },
  { key: "move", label: "Move 5 min" },
] as const;
export type BodyKey = (typeof BODY_ITEMS)[number]["key"];

/** Where a block ends when no anchor is left today (local hour). */
const DAY_END_HOUR = 21;
/** Where the first block of the day starts at the earliest (local hour). */
const DAY_START_HOUR = 6;

export interface Block {
  /** Stable id for this stretch; changes when the anchor passes, which resets the checks. */
  key: string;
  start: Date;
  end: Date;
}

/**
 * The stretch the body checks belong to: from the end of the last anchor
 * that finished (or the start of the day) up to the next anchor.
 */
export function currentBlock(next: Anchor | null, lastEnded: Anchor | null, now: Date, tz: string): Block {
  const today = localDate(now, tz);
  const p = localParts(now, tz);
  const dayStart = zonedInstant(p.year, p.month, p.day, DAY_START_HOUR, 0, tz);
  const lastEnd = lastEnded?.end ? new Date(lastEnded.end) : null;
  const start = lastEnd && lastEnd > dayStart && lastEnd <= now ? lastEnd : dayStart;
  if (next) {
    return { key: `${next.id}@${next.start}`, start, end: new Date(next.start) };
  }
  const dayEnd = zonedInstant(p.year, p.month, p.day, DAY_END_HOUR, 0, tz);
  return { key: `${today}:open`, start, end: dayEnd > now ? dayEnd : now };
}

/** Parses "08:00,12:30,18:30" into [[8,0],[12,30],[18,30]]. */
export function parseMealtimes(spec: string | undefined): [number, number][] {
  const raw = spec?.trim() || "08:00,12:30,18:30";
  return raw
    .split(",")
    .map((s) => s.trim().split(":").map(Number) as [number, number])
    .filter(([h, m]) => Number.isFinite(h) && Number.isFinite(m));
}

/** True when a mealtime falls inside the block (on any day it spans). */
export function crossesMealtime(block: Block, mealtimes: [number, number][], tz: string): boolean {
  const days = new Set([localDate(block.start, tz), localDate(block.end, tz)]);
  for (const day of days) {
    const [y, m, d] = day.split("-").map(Number);
    for (const [h, min] of mealtimes) {
      const t = zonedInstant(y, m, d, h, min, tz);
      if (t >= block.start && t <= block.end) return true;
    }
  }
  return false;
}

export interface BodyCheck {
  key: BodyKey;
  label: string;
  done: boolean;
}

export function bodyChecks(showFood: boolean, done: Partial<Record<BodyKey, boolean>>): BodyCheck[] {
  return BODY_ITEMS.filter((i) => i.key !== "eat" || showFood).map((i) => ({
    key: i.key,
    label: i.label,
    done: !!done[i.key],
  }));
}

// ---- KV ---------------------------------------------------------------

const TWO_DAYS = 2 * 86400;

export async function readMode(kv: KVNamespace, date: string): Promise<Mode | null> {
  const v = await kv.get(`mode:${date}`);
  return v && (MODES as readonly string[]).includes(v) ? (v as Mode) : null;
}

export async function writeMode(kv: KVNamespace, date: string, mode: Mode): Promise<void> {
  await kv.put(`mode:${date}`, mode, { expirationTtl: TWO_DAYS });
}

export async function readBody(kv: KVNamespace, blockKey: string): Promise<Partial<Record<BodyKey, boolean>>> {
  return ((await kv.get(`body:${blockKey}`, "json")) as Partial<Record<BodyKey, boolean>> | null) ?? {};
}

export async function writeBody(
  kv: KVNamespace,
  blockKey: string,
  state: Partial<Record<BodyKey, boolean>>,
): Promise<void> {
  await kv.put(`body:${blockKey}`, JSON.stringify(state), { expirationTtl: TWO_DAYS });
}
