# Now app — Phase 1

A read-only "Now" screen for ADHD day management. It shows the next calendar
anchor, today's Todoist tasks grouped by location, and the Waiting on list, with
every link one tap away. Nothing is written to Todoist or Google Calendar.

One Cloudflare Worker serves both the web app (`public/`) and its API.

```
src/worker.ts    routes: /api/state, /api/mode, /api/body, /api/now, /auth/google
src/todoist.ts   Todoist API v1 reads, candidate tasks, Waiting on lists
src/calendar.ts  Google OAuth (read-only) and anchor rules
src/links.ts     link parsing and chip labels
src/body.ts      body checks and today's mode (KV)
src/access.ts    Cloudflare Access JWT check, feed token check
src/time.ts      time-zone helpers
public/          HTML, CSS, JS, PWA manifest and icons
```

## Routes

| Route | Auth | What it does |
| --- | --- | --- |
| `/`, static files | Cloudflare Access | The web app |
| `GET /api/state` | Access | Everything the app shows. `?fresh=1` skips the 60 s cache |
| `POST /api/mode` | Access | `{ "mode": "Admin" \| "Deep" \| "Up & About" }`, saved in KV for today |
| `POST /api/body` | Access | `{ "block", "item": "water" \| "eat" \| "move", "done" }`, saved in KV |
| `GET /auth/google` | Access | One-time Google consent; stores the refresh token in KV |
| `GET /api/now?token=…` | Feed token | Small JSON for the Phase 4 widget |

## Rules worth knowing

- **Anchor**: a timed event you haven't declined that shows as busy. All-day,
  free, cancelled, working-location and out-of-office events are skipped. Set
  `ANCHOR_RULE = "people_or_place"` in `wrangler.toml` to also require another
  attendee, a location or a video link.
- **Candidate tasks**: due today or overdue, plus anything labelled
  `Flexible Date` (exact spelling), minus `✅_streak` routines and `(w)` items.
  Grouped by `Computer`, `Upstairs`, `Downstairs`, then Anywhere.
- **Waiting on**: tasks starting `(w)`. Due today or earlier → Check today
  (oldest first); later or undated → Coming up. "Nudged" comes from the newest
  comment starting "Followed up".
- **Body checks** belong to the stretch before the next anchor and reset when it
  passes. "Eat something" appears only when that stretch crosses a mealtime
  (`MEALTIMES`, default 08:00, 12:30, 18:30).

## Setup

You need Node 20+ and this repo checked out. Run `npm install` first.

1. **Cloudflare account.** Sign up free at dash.cloudflare.com, then
   `npx wrangler login`.
2. **KV namespace.** `npx wrangler kv namespace create NOW_KV` and paste the
   printed `id` into `wrangler.toml`.
3. **Todoist token.** Todoist → Settings → Integrations → Developer → copy the
   API token, then `npx wrangler secret put TODOIST_TOKEN`.
4. **Feed token.** `openssl rand -hex 32`, then
   `npx wrangler secret put FEED_TOKEN` and paste it. Keep a copy for KWGT.
5. **Deploy.** `npm run deploy`. Note the URL it prints
   (`https://now-app.<you>.workers.dev`).
6. **Cloudflare Access.** Zero Trust dashboard → Settings → Authentication → add
   Google as a login method. Then Access → Applications → Add → Self-hosted:
   - Domain: your Worker's hostname. Policy: Allow, Include → Emails → your
     Gmail address.
   - Add a second application for the same hostname with path `api/now`, policy
     action **Bypass**, Include → Everyone. (The Worker checks the feed token.)
   - Copy the first application's **Application Audience (AUD) tag** and your
     team domain (`<team>.cloudflareaccess.com`) into `ACCESS_AUD` and
     `ACCESS_TEAM_DOMAIN` in `wrangler.toml`, put your email in `ALLOWED_EMAIL`,
     and deploy again. Until these are set, every route except the feed
     answers 403.
   - Workers → now-app → Settings → Domains & Routes: turn on Cloudflare Access
     for the workers.dev URL too (or turn workers.dev off and use a custom domain).
7. **Google Cloud.** console.cloud.google.com → new project → APIs & Services:
   - Enable the **Google Calendar API**.
   - OAuth consent screen: External, add yourself as a test user, add the
     scope `.../auth/calendar.readonly`. Then **Publish app** (otherwise Google
     expires the refresh token after 7 days).
   - Credentials → Create OAuth client ID → Web application. Authorized redirect
     URI: `https://<your worker host>/auth/google/callback`.
   - `npx wrangler secret put GOOGLE_CLIENT_ID` and
     `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
8. **Connect Calendar.** Visit `https://<your worker host>/auth/google` once and
   approve. The refresh token is stored in KV, server-side only.
9. **Phone.** Open the URL in Chrome on the Pixel → ⋮ → Add to Home screen →
   Install.

## Development

```
cp .dev.vars.example .dev.vars   # fill in tokens; DEV_SKIP_ACCESS=true skips Access locally
npm run dev
npm test                          # rules and Worker tests, with Todoist/Google stubbed
npm run typecheck
```

## Acceptance (2–3 normal days)

- [ ] Next anchor and minutes free match the calendar
- [ ] Join opens the right meeting; Agenda opens the right doc
- [ ] Task lists match Todoist, with no streak routines and no `(w)` tasks
- [ ] Every link in a task description is a chip that opens on the first tap
- [ ] Waiting on splits correctly into Check today and Coming up
- [ ] Water, food and movement chips check, and reset after the anchor
- [ ] `/api/now` returns the agreed JSON shape and rejects a wrong token
- [ ] Loads in under 2 seconds on the phone
