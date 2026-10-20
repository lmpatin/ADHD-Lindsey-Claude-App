// Now app — Phase 1 web client. Read-only views of /api/state, plus the
// mode menu and body-check chips (both saved in KV through the Worker).

(() => {
  "use strict";

  const REFRESH_MS = 60_000;
  const MODE_LOCATION = { "Admin": "Computer", "Deep": "Computer", "Up & About": "Downstairs" };

  let state = null;
  let tab = location.hash === "#waiting" ? "waiting" : "now";
  let modeMenuOpen = false;
  let loading = false;
  let loadError = null;

  const view = document.getElementById("view");
  const badge = document.getElementById("waiting-badge");

  // ---- Helpers --------------------------------------------------------

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const tz = () => (state && state.timezone) || undefined;

  function fmt(date, opts) {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz(), ...opts }).format(date);
  }
  const clock = (d) => fmt(d, { hour: "numeric", minute: "2-digit" });
  const clockShort = (d) => clock(d).replace(/\s?[AP]M$/, "");
  const dayLabel = (d) => fmt(d, { weekday: "short", month: "short", day: "numeric" });
  const localDay = (d) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" });

  function duration(min) {
    const m = Math.max(0, Math.round(min));
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h === 0) return `${r}m`;
    return r === 0 ? `${h}h` : `${h}h ${r}m`;
  }

  const ARROW =
    '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7"/><path d="M9 7h8v8"/></svg>';
  const CHECK =
    '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function chip(url, label, cls = "") {
    return `<a class="link-chip ${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><span>${esc(label)}</span>${ARROW}</a>`;
  }

  function taskChips(t) {
    return (t.links || []).map((l) => chip(l.url, l.label)).join("") + chip(t.todoist_url, "Open in Todoist", "plain");
  }

  // ---- Data -----------------------------------------------------------

  async function load(fresh = false) {
    if (loading) return;
    loading = true;
    setSpinning(true);
    try {
      const res = await fetch(`/api/state${fresh ? "?fresh=1" : ""}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "Signed out. Reload to sign in again." : `Couldn't load (${res.status}).`);
      state = await res.json();
      loadError = null;
    } catch (err) {
      loadError = err.message || String(err);
    } finally {
      loading = false;
      setSpinning(false);
      render();
    }
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Save failed (${res.status})`);
    return res.json();
  }

  function setSpinning(on) {
    const btn = document.getElementById("refresh");
    if (btn) btn.classList.toggle("spinning", on);
  }

  // ---- Rendering ------------------------------------------------------

  function render() {
    document.querySelectorAll(".tab").forEach((a) => {
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });

    const dueCount = state ? state.waiting.check_today.length : 0;
    badge.hidden = dueCount === 0;
    badge.textContent = String(dueCount);

    if (!state) {
      view.innerHTML = loadError ? `<div class="error">${esc(loadError)}</div>` : '<div class="loading">Loading…</div>';
      return;
    }
    view.innerHTML = tab === "waiting" ? renderWaiting() : renderNow();
  }

  function topline() {
    const now = new Date();
    return `
      <div class="topline">
        <div class="date">${esc(dayLabel(now))}</div>
        <div class="right">
          <div class="clock" id="clock">${esc(clock(now))}</div>
          <button class="icon-btn ${loading ? "spinning" : ""}" id="refresh" type="button" aria-label="Refresh">
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>
          </button>
        </div>
      </div>`;
  }

  function errors() {
    const out = [];
    if (loadError) out.push(`<div class="error">${esc(loadError)}</div>`);
    const e = state.errors || {};
    if (e.calendar) {
      const connect = /auth\/google/.test(e.calendar) ? ' <a href="/auth/google">Connect Google Calendar</a>' : "";
      out.push(`<div class="error">Calendar: ${esc(e.calendar)}${connect}</div>`);
    }
    if (e.todoist) out.push(`<div class="error">Todoist: ${esc(e.todoist)}</div>`);
    return out.join("");
  }

  function minutesUntil(iso) {
    return (Date.parse(iso) - Date.now()) / 60000;
  }

  function anchorCard() {
    const a = state.next_anchor;
    const cur = state.current_anchor;
    const nowLine = cur
      ? `<div class="now-line">In progress: ${esc(cur.title)}${cur.end ? ` until ${esc(clock(new Date(cur.end)))}` : ""}</div>`
      : "";

    let head;
    let free;
    if (a) {
      const start = new Date(a.start);
      const tomorrow = localDay(start) !== localDay(new Date());
      const chips = [
        a.join_url ? chip(a.join_url, a.join_label || "Join") : "",
        a.agenda_url ? chip(a.agenda_url, "Agenda", "plain") : "",
        ...(a.links || []).map((l) => chip(l.url, l.label, "plain")),
      ].join("");
      head = `
        <div class="anchor-head">
          <div class="eyebrow">Next anchor${tomorrow ? " · tomorrow" : ""}</div>
          <div class="anchor-time">${esc(clock(start))}</div>
          <div class="anchor-title">${esc(a.title)}</div>
          ${a.location ? `<div class="anchor-sub">${esc(a.location)}</div>` : ""}
          ${chips ? `<div class="chips" style="margin-top:8px">${chips}</div>` : ""}
        </div>`;
      free = `
        <div class="free">
          <div class="big" id="free-big">${esc(duration(minutesUntil(a.start)))}</div>
          <div class="small">free until then</div>
        </div>`;
    } else {
      head = `
        <div class="anchor-head">
          <div class="eyebrow">Next anchor</div>
          <div class="anchor-title">No more anchors today.</div>
        </div>`;
      free = `<div class="free"><div class="small">The rest of the day is open.</div></div>`;
    }

    return `
      <section class="card" aria-label="Next anchor">
        ${nowLine}
        ${head}
        <div class="divider"></div>
        ${free}
        <div class="chips">${modeChip()}${locationChip()}</div>
      </section>`;
  }

  function modeChip() {
    const m = state.mode;
    const label = m ? `${m} day` : "Pick today's mode";
    const menu = modeMenuOpen
      ? `<div class="mode-menu" role="menu" aria-label="Today's mode">
          ${state.modes
            .map(
              (opt) =>
                `<button type="button" role="menuitemradio" aria-checked="${opt === m}" data-mode="${esc(opt)}">${esc(opt)}${opt === m ? CHECK : ""}</button>`,
            )
            .join("")}
        </div>`
      : "";
    return `
      <div class="mode-wrap">
        <button type="button" class="pill ${m ? "mode" : "unset"}" id="mode-btn" aria-haspopup="menu" aria-expanded="${modeMenuOpen}">${esc(label)}</button>
        ${menu}
      </div>`;
  }

  function locationChip() {
    const loc = state.mode && MODE_LOCATION[state.mode];
    return loc ? `<span class="pill" style="cursor:default">${esc(loc)}</span>` : "";
  }

  function bodySection() {
    const checks = state.block.checks;
    const end = new Date(state.block.end);
    return `
      <section class="section" aria-label="During this block">
        <div class="eyebrow">During this block</div>
        <div class="body-chips">
          ${checks
            .map(
              (c) => `
            <button type="button" class="body-chip" aria-pressed="${c.done}" data-body="${esc(c.key)}">
              <span class="box">${c.done ? CHECK : ""}</span>${esc(c.label)}
            </button>`,
            )
            .join("")}
        </div>
        <div class="body-note">Resets at ${esc(clock(end))}</div>
      </section>`;
  }

  function taskMeta(t) {
    const bits = [];
    if (t.overdue) bits.push(`<span class="due-badge">Overdue</span>`);
    if (t.due_time) bits.push(esc(t.due_time));
    if (t.flexible && !t.overdue) bits.push("Flexible");
    if (t.duration_minutes) bits.push(esc(duration(t.duration_minutes)));
    if (t.priority < 4) bits.push(`P${t.priority}`);
    if (t.project) bits.push(esc(t.project));
    return bits.length ? `<div class="task-meta">${bits.join('<span aria-hidden="true">·</span>')}</div>` : "";
  }

  function taskList() {
    let groups = state.tasks.slice();
    const loc = state.mode && MODE_LOCATION[state.mode];
    if (loc) groups.sort((a, b) => (b.location === loc) - (a.location === loc));
    if (!groups.length) {
      return `<section class="section"><div class="eyebrow">Today's tasks</div><div class="empty">${
        state.errors.todoist ? "Tasks couldn't load." : "Nothing due today."
      }</div></section>`;
    }
    return `
      <section class="section" aria-label="Today's tasks">
        <div class="eyebrow">Today's tasks</div>
        ${groups
          .map(
            (g) => `
          <div class="group">
            <div class="group-head"><div class="eyebrow">${esc(g.location)}</div><div class="count">${g.tasks.length}</div></div>
            ${g.tasks
              .map(
                (t) => `
              <article class="task">
                <div>
                  <div class="task-title">${esc(t.title)}</div>
                  ${taskMeta(t)}
                </div>
                <div class="chips">${taskChips(t)}</div>
              </article>`,
              )
              .join("")}
          </div>`,
          )
          .join("")}
      </section>`;
  }

  function waitingRow() {
    const n = state.waiting.check_today.length;
    const label = n === 0 ? "No checks due today" : `${n} ${n === 1 ? "check" : "checks"} due today`;
    return `
      <a class="waiting-row" href="#waiting">
        <span class="dot ${n === 0 ? "calm" : ""}"></span>
        <span class="label">${label}</span>
        <span class="hint">Waiting on</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#A8A193" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      </a>`;
  }

  function laterToday() {
    const rows = state.later_today;
    return `
      <section class="later" aria-label="Later today">
        <div class="eyebrow">Later today</div>
        ${
          rows.length
            ? rows
                .map(
                  (a) =>
                    `<div class="later-row"><div class="t">${esc(clockShort(new Date(a.start)))}</div><div class="n">${esc(a.title)}</div></div>`,
                )
                .join("")
            : '<div class="empty">Nothing else on the calendar today.</div>'
        }
      </section>`;
  }

  function renderNow() {
    return [topline(), errors(), anchorCard(), bodySection(), waitingRow(), taskList(), laterToday()].join("");
  }

  function renderWaiting() {
    const { check_today, coming_up } = state.waiting;
    const today = check_today.length
      ? check_today
          .map(
            (t) => `
        <article class="w-card">
          <div style="display:flex;flex-direction:column;gap:4px">
            <div class="task-title">${esc(t.title)}</div>
            <div class="task-meta">${esc(t.meta)}</div>
          </div>
          <div class="chips">${taskChips(t)}</div>
          <div class="w-actions">
            <button type="button" class="outline" disabled title="Arrives in Phase 2">Followed up</button>
            <button type="button" class="solid" disabled title="Arrives in Phase 2">${CHECK} Resolved</button>
          </div>
          <div class="phase-note">Buttons arrive in Phase 2</div>
        </article>`,
          )
          .join("")
      : '<div class="w-card"><div class="task-meta" style="font-size:15px">Nothing to check today.</div></div>';

    const upcoming = coming_up.length
      ? coming_up
          .map(
            (u) => `
        <article class="up-row">
          <div class="up-top">
            <div class="text">
              <div class="up-title">${esc(u.title)}</div>
              <div class="task-meta">${esc(u.meta)}</div>
            </div>
            <div class="when-badge">${esc(u.check_label || "No date")}</div>
          </div>
          <div class="chips">${taskChips(u)}</div>
        </article>`,
          )
          .join("")
      : '<div class="empty">Nothing else waiting.</div>';

    return `
      ${topline()}
      <div style="display:flex;flex-direction:column;gap:4px">
        <h1>Waiting on</h1>
        <div class="subtitle">Your (w) tasks from Todoist</div>
      </div>
      ${errors()}
      <section class="section" aria-label="Check today">
        <div class="eyebrow-row"><span class="dot"></span><div class="eyebrow">Check today · ${check_today.length}</div></div>
        ${today}
      </section>
      <section class="section" aria-label="Coming up">
        <div class="eyebrow">Coming up</div>
        ${upcoming}
      </section>`;
  }

  // ---- Events ---------------------------------------------------------

  view.addEventListener("click", async (ev) => {
    const target = ev.target.closest("button");
    if (!target) {
      if (modeMenuOpen) {
        modeMenuOpen = false;
        render();
      }
      return;
    }

    if (target.id === "refresh") return load(true);

    if (target.id === "mode-btn") {
      modeMenuOpen = !modeMenuOpen;
      render();
      if (modeMenuOpen) view.querySelector(".mode-menu button")?.focus();
      return;
    }

    if (target.dataset.mode) {
      const prev = state.mode;
      state.mode = target.dataset.mode;
      modeMenuOpen = false;
      render();
      document.getElementById("mode-btn")?.focus();
      try {
        await post("/api/mode", { mode: state.mode });
      } catch (err) {
        state.mode = prev;
        loadError = err.message;
        render();
      }
      return;
    }

    if (target.dataset.body) {
      const key = target.dataset.body;
      const check = state.block.checks.find((c) => c.key === key);
      if (!check) return;
      check.done = !check.done;
      render();
      try {
        await post("/api/body", { block: state.block.key, item: key, done: check.done });
      } catch (err) {
        check.done = !check.done;
        loadError = err.message;
        render();
      }
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && modeMenuOpen) {
      modeMenuOpen = false;
      render();
      document.getElementById("mode-btn")?.focus();
    }
  });

  window.addEventListener("hashchange", () => {
    tab = location.hash === "#waiting" ? "waiting" : "now";
    modeMenuOpen = false;
    render();
    window.scrollTo(0, 0);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") load();
  });

  // Clock and minutes-free tick between refreshes; the block resets when its anchor passes.
  setInterval(() => {
    if (!state) return;
    const c = document.getElementById("clock");
    if (c) c.textContent = clock(new Date());
    const f = document.getElementById("free-big");
    if (f && state.next_anchor) f.textContent = duration(minutesUntil(state.next_anchor.start));
    if (state.next_anchor && Date.parse(state.next_anchor.start) <= Date.now() && !loading) load(true);
  }, 15_000);

  setInterval(() => {
    if (document.visibilityState === "visible") load();
  }, REFRESH_MS);

  render();
  load();
})();
