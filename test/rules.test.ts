import { describe, expect, it } from "vitest";
import { bodyChecks, crossesMealtime, currentBlock, parseMealtimes } from "../src/body";
import { isAnchor, joinLink, planAnchors, toAnchor, type RawEvent } from "../src/calendar";
import { chipLabel, extractLinks, plainText } from "../src/links";
import { isoLocal, localDate, zonedInstant } from "../src/time";
import {
  candidateTasks,
  dueDate,
  isWaiting,
  latestFollowUp,
  waitingLists,
  type RawTask,
  type TodoistSnapshot,
} from "../src/todoist";

const TZ = "America/Los_Angeles";
// Tue Oct 20 2026, 1:20 PM PDT
const NOW = new Date("2026-10-20T20:20:00Z");

describe("time", () => {
  it("formats local ISO with offset", () => {
    expect(isoLocal(NOW, TZ)).toBe("2026-10-20T13:20:00-07:00");
  });
  it("converts wall time to an instant across DST", () => {
    expect(zonedInstant(2026, 10, 20, 15, 0, TZ).toISOString()).toBe("2026-10-20T22:00:00.000Z");
    expect(zonedInstant(2026, 12, 1, 9, 0, TZ).toISOString()).toBe("2026-12-01T17:00:00.000Z");
  });
  it("uses the local date, not UTC", () => {
    expect(localDate(new Date("2026-10-21T05:00:00Z"), TZ)).toBe("2026-10-20");
  });
});

describe("links", () => {
  it("reads markdown and bare links, without duplicates", () => {
    const links = extractLinks(
      "Reply to [Dana's email](https://mail.google.com/mail/u/0/#inbox/abc)",
      "Notes: https://www.notion.so/Plan-123. Also https://docs.google.com/spreadsheets/d/x/edit, and https://mail.google.com/mail/u/0/#inbox/abc",
    );
    expect(links).toEqual([
      { label: "Dana's email", url: "https://mail.google.com/mail/u/0/#inbox/abc" },
      { label: "Notion", url: "https://www.notion.so/Plan-123" },
      { label: "Google Sheet", url: "https://docs.google.com/spreadsheets/d/x/edit" },
    ]);
  });
  it("reads HTML anchors from calendar descriptions", () => {
    const links = extractLinks('Agenda: <a href="https://docs.google.com/document/d/1/edit">https://docs.google.com/document/d/1/edit</a>');
    expect(links).toEqual([{ label: "Google Doc", url: "https://docs.google.com/document/d/1/edit" }]);
  });
  it("labels by known domain, else hostname", () => {
    expect(chipLabel("https://acme.my.salesforce.com/lightning/r/1")).toBe("Salesforce");
    expect(chipLabel("https://us02web.zoom.us/j/123")).toBe("Zoom");
    expect(chipLabel("https://www.example.org/x")).toBe("example.org");
  });
  it("shows markdown link text without the markup", () => {
    expect(plainText("Read [the brief](https://x.com/a) today")).toBe("Read the brief today");
  });
});

function task(p: Partial<RawTask> & { id: string; content: string }): RawTask {
  return { labels: [], priority: 1, added_at: "2026-10-14T17:00:00Z", ...p };
}

const snap: TodoistSnapshot = {
  projects: { p1: "Work" },
  followedUp: { w1: "2026-10-16", w2: null, w3: null },
  tasks: [
    task({ id: "a", content: "Send invoice", due: { date: "2026-10-20" }, labels: ["Computer"], project_id: "p1" }),
    task({ id: "b", content: "Old thing", due: { date: "2026-10-18" }, labels: ["Upstairs"] }),
    task({ id: "c", content: "Fold laundry", labels: ["Flexible Date", "Downstairs"] }),
    task({ id: "d", content: "Morning pages", due: { date: "2026-10-20" }, labels: ["✅_streak"] }),
    task({ id: "e", content: "Next week", due: { date: "2026-10-27" } }),
    task({ id: "f", content: "Timed call", due: { date: "2026-10-20T16:00:00" }, labels: ["flexible date"] }),
    task({ id: "w1", content: "(w) District IT — SSO creds", due: { date: "2026-10-20" }, added_at: "2026-10-14T17:00:00Z" }),
    task({ id: "w2", content: "  (W) Refund for part", due: { date: "2026-10-19" }, added_at: "2026-10-11T17:00:00Z" }),
    task({ id: "w3", content: "(w) Procurement redlines", due: { date: "2026-10-22" }, added_at: "2026-10-17T17:00:00Z" }),
  ],
};

describe("todoist", () => {
  it("detects (w) ignoring case and leading spaces", () => {
    expect(isWaiting("  (W) x")).toBe(true);
    expect(isWaiting("x (w)")).toBe(false);
  });

  it("reads floating and UTC due dates as local dates", () => {
    expect(dueDate(task({ id: "x", content: "", due: { date: "2026-10-21T03:00:00Z" } }), TZ)).toBe("2026-10-20");
    expect(dueDate(task({ id: "x", content: "", due: { date: "2026-10-21T03:00:00" } }), TZ)).toBe("2026-10-21");
  });

  it("builds candidate tasks: today|overdue + Flexible Date, no streaks or (w)", () => {
    const groups = candidateTasks(snap, NOW, TZ);
    const ids = groups.flatMap((g) => g.tasks.map((t) => t.id));
    expect(ids.sort()).toEqual(["a", "b", "c", "f"]);
    expect(groups.map((g) => g.location)).toEqual(["Computer", "Upstairs", "Downstairs", "Anywhere"]);
    const a = groups[0].tasks[0];
    expect(a.project).toBe("Work");
    expect(a.links.at(-1)).toBeUndefined();
    expect(a.todoist_url).toBe("https://app.todoist.com/app/task/a");
    expect(groups[1].tasks[0].overdue).toBe(true);
  });

  it("matches the Flexible Date label exactly", () => {
    const groups = candidateTasks(snap, NOW, TZ);
    const f = groups.flatMap((g) => g.tasks).find((t) => t.id === "f")!;
    expect(f.flexible).toBe(false); // "flexible date" is a different label
  });

  it("splits waiting items into Check today (oldest first) and Coming up", () => {
    const w = waitingLists(snap, NOW, TZ);
    expect(w.check_today.map((t) => t.id)).toEqual(["w2", "w1"]);
    expect(w.check_today[0].title).toBe("Refund for part");
    expect(w.check_today[0].meta).toBe("Waiting 9 days · not nudged yet");
    expect(w.check_today[1].meta).toBe("Waiting 6 days · nudged Oct 16");
    expect(w.coming_up.map((t) => [t.id, t.check_label])).toEqual([["w3", "Thu 22"]]);
  });

  it("takes the newest Followed up comment", () => {
    expect(
      latestFollowUp(
        [
          { id: "1", content: "Followed up by email", posted_at: "2026-10-13T18:00:00Z" },
          { id: "2", content: "followed up again", posted_at: "2026-10-16T18:00:00Z" },
          { id: "3", content: "Note: they replied", posted_at: "2026-10-18T18:00:00Z" },
        ],
        TZ,
      ),
    ).toBe("2026-10-16");
  });
});

function ev(p: Partial<RawEvent> & { id: string; start: string; end?: string }): RawEvent {
  return {
    summary: p.id,
    ...p,
    start: { dateTime: p.start },
    end: { dateTime: p.end ?? p.start },
  } as RawEvent;
}

describe("anchors", () => {
  const events: RawEvent[] = [
    ev({ id: "standup", start: "2026-10-20T16:00:00Z", end: "2026-10-20T16:30:00Z" }),
    ev({ id: "lunch-block", start: "2026-10-20T19:30:00Z", end: "2026-10-20T20:00:00Z" }),
    ev({ id: "focus", start: "2026-10-20T21:00:00Z", end: "2026-10-20T21:30:00Z", transparency: "transparent" }),
    ev({
      id: "declined",
      start: "2026-10-20T21:30:00Z",
      attendees: [{ self: true, responseStatus: "declined" }],
    }),
    ev({
      id: "demo",
      summary: "Customer demo",
      start: "2026-10-20T22:00:00Z",
      end: "2026-10-20T23:00:00Z",
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      description:
        'Agenda <a href="https://docs.google.com/document/d/9/edit">doc</a> and deck https://docs.google.com/presentation/d/7 and https://acme.com/brief',
      attendees: [{ self: true, responseStatus: "accepted" }, { email: "x@y.com" }],
    }),
    ev({ id: "pickup", start: "2026-10-21T00:30:00Z" }),
    { id: "allday", start: { date: "2026-10-20" }, end: { date: "2026-10-21" } },
    ev({ id: "tomorrow", start: "2026-10-21T16:00:00Z" }),
  ];

  it("skips all-day, free and declined events; next is the first after now", () => {
    const plan = planAnchors(events, NOW, TZ);
    expect(plan.next?.title).toBe("Customer demo");
    expect(plan.later_today.map((a) => a.id)).toEqual(["pickup"]);
    expect(plan.last_ended?.id).toBe("lunch-block");
    expect(plan.current).toBeNull();
  });

  it("picks Join and Agenda links", () => {
    const a = toAnchor(events[4]);
    expect(a.join_url).toBe("https://meet.google.com/abc-defg-hij");
    expect(a.agenda_url).toBe("https://docs.google.com/document/d/9/edit");
    expect(a.links.map((l) => l.url)).toEqual([
      "https://docs.google.com/presentation/d/7",
      "https://acme.com/brief",
    ]);
  });

  it("falls back to a Zoom URL in the location", () => {
    const j = joinLink(ev({ id: "z", start: "2026-10-20T22:00:00Z", location: "https://us02web.zoom.us/j/555" }));
    expect(j).toEqual({ url: "https://us02web.zoom.us/j/555", label: "Join Zoom" });
  });

  it("supports the stricter people_or_place rule", () => {
    expect(isAnchor(events[0], "people_or_place")).toBe(false);
    expect(isAnchor(events[4], "people_or_place")).toBe(true);
  });
});

describe("body checks", () => {
  const meals = parseMealtimes("08:00,12:30,18:30");
  it("shows food only when the block crosses a mealtime", () => {
    const plan = planAnchors(
      [
        ev({ id: "a", start: "2026-10-20T19:30:00Z", end: "2026-10-20T20:00:00Z" }), // ends 1:00 PM
        ev({ id: "b", start: "2026-10-20T22:00:00Z" }), // 3:00 PM
      ],
      NOW,
      TZ,
    );
    const block = currentBlock(plan.next, plan.last_ended, NOW, TZ);
    expect(block.start.toISOString()).toBe("2026-10-20T20:00:00.000Z");
    expect(crossesMealtime(block, meals, TZ)).toBe(false);
    expect(bodyChecks(false, { water: true }).map((c) => [c.key, c.done])).toEqual([
      ["water", true],
      ["move", false],
    ]);

    const early = currentBlock(plan.next, null, new Date("2026-10-20T18:00:00Z"), TZ);
    expect(crossesMealtime(early, meals, TZ)).toBe(true);
  });

  it("keys the block to its anchor so checks reset when it passes", () => {
    const plan = planAnchors([ev({ id: "b", start: "2026-10-20T22:00:00Z" })], NOW, TZ);
    expect(currentBlock(plan.next, null, NOW, TZ).key).toBe("b@2026-10-20T22:00:00.000Z");
  });
});
