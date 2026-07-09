# Unattended daily deploy (GitHub Actions)

The stock pipeline runs itself: fetch → script → voice → render → schedule to
Facebook. Once set up, you never touch it.

## How the timing works

The workflow fires at **22:15 UTC, Mon–Fri** (`.github/workflows/daily.yml`).
That's 18:15 ET in summer, 17:15 ET in winter — comfortably after the 16:00 ET
close in both DST regimes. A second cron runs **13:00 UTC Saturday** for the
weekend wrap.

**Cron precision doesn't matter.** The run renders all three reels and then
hands Facebook three future `scheduled_publish_time` values. Meta publishes them
at the right moment, so GitHub's routine cron jitter (5–30 min) is harmless. The
run only needs to *finish* before the earliest slot.

**Weekday slots** (ET wall-clock, DST-correct — see `server/stock/market.mjs`):

| Reel type      | Slot            | Why |
| -------------- | --------------- | --- |
| `top-mover`    | same day 19:30  | Strongest hook into the evening Reels peak |
| `headline`     | next day 08:00  | Pre-market commute; news still fresh |
| `market-recap` | next day 12:30  | Lunch scroll; recap content ages well |

**Weekend slots.** The Saturday run produces a weekly wrap of exactly two reels
(the scriptwriter omits `headline` in weekly mode) and spreads them so neither
weekend day is dark:

| Reel type      | Slot                | 
| -------------- | ------------------- |
| `top-mover`    | Saturday 11:00 ET   |
| `market-recap` | Sunday 11:00 ET     |

There is no Sunday cron — Sunday's video is scheduled by Saturday's run.

If a same-day slot has already passed (badly delayed run), it's clamped to
~12 minutes out and staggered 45 min apart rather than rolled to tomorrow — a
day-late "top mover" would collide with the next day's real one.

## Days it produces nothing

- **NYSE holidays** → skipped before any API call. The list lives in
  `market.mjs` and **is not self-maintaining — extend it each year.**
- **Stale quotes** → if the freshest Finnhub quote isn't from today's ET
  session, the run aborts rather than narrate yesterday's prices as "today".
  This is the backstop for a stale holiday list.

(Weekends are *not* dark — see the weekend slots above.)

## Setup

### 1. Make the repo private

The music tracks in `assets/stock/music/` are now committed so CI has a music
bed. They're licensed audio — **keep the repo private.** Private also keeps the
LLM system prompt and content strategy out of competitors' hands, and the free
tier (2,000 Linux min/month) comfortably covers ~22 runs × ~25 min ≈ 550 min.

### 2. Add GitHub Secrets

Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Where it comes from |
| ------ | ------------------- |
| `FINNHUB_API_KEY` | finnhub.io free tier |
| `GEMINI_API_KEY` | aistudio.google.com/apikey |
| `FB_PAGE_ID` | `/me/accounts` response (see below) |
| `FB_PAGE_ACCESS_TOKEN` | `/me/accounts` response (see below) |
| `FMP_API_KEY` | *(optional — only if `STOCK_DATA_PROVIDER=fmp`)* |

Optional non-secret **Variables** (same page, "Variables" tab):
`STOCK_DATA_PROVIDER`, `STOCK_TTS_VOICE`.

### 3. Facebook Page token

Page tokens derived from a long-lived user token don't expire, but they die if
you change your Facebook password, reset the App Secret, or revoke app access.

```
node server/stock/setupFbToken.mjs <short-lived-user-token>
```

Get the short-lived token from Graph API Explorer with `pages_show_list`,
`pages_read_engagement`, and `pages_manage_posts` granted. The script exchanges
it, writes `FB_PAGE_ID` / `FB_PAGE_ACCESS_TOKEN` into `.env`, and prints only the
Page name — never the token. Copy those two values into GitHub Secrets.

**Never paste a token or the App Secret into a chat, an issue, or a commit.**

### 4. Test before trusting it

Actions → *Daily stock reels* → **Run workflow**. `dry_run` defaults to **true**,
so it renders and prints the slots without posting:

```
[dry-run] 01_top-mover-arm.mp4  (top-mover)  ->  Jul 9, 2026, 7:30 PM ET
```

Once that looks right, run it again with `dry_run` unchecked, or just let the
22:15 UTC cron take over.

## When it breaks

GitHub emails you on a failed workflow run — that's the alerting. Rendered mp4s
and `pipeline.log` are uploaded as a run artifact (3-day retention) so you can
see what went wrong.

Publishing runs **last**, so a Facebook failure never destroys a good render.
Retry without re-rendering:

```
node server/stock/publish.mjs --slots 2026-07-09            # schedule into slots
node server/stock/publish.mjs --slots 2026-07-09 --dry-run  # preview only
node server/stock/publish.mjs 2026-07-09 1                  # publish reel #1 now
```

## Known gaps

- **No AI-content label.** Meta's Reels publishing API exposes no parameter for
  it (verified against the Graph API reference) — the toggle is UI-only. The
  content does fall under Meta's synthetic-media disclosure rule (AI narration,
  AI backdrops), so there's residual risk of an auto-applied label or strike.
  Cheapest fix if you ever want it: append a disclosure line to `fbCaption`.
- **NYSE holiday list expires.** Extend `NYSE_HOLIDAYS` in `market.mjs` each
  year. The stale-quote check will catch a miss, but it wastes a run's API quota.
- **Instagram is not wired up.** IG's Reels API only accepts a public `video_url`,
  not a file upload, so it needs the mp4 hosted somewhere first.
