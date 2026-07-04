# Stock Market Reel Pipeline — Strategy & Architecture Plan

> Planning document only. Nothing here is built yet. This adds a **second
> workflow** ("Stock") to the existing Aussie Nostalgia app, reusing its
> Remotion + Express + output infrastructure while keeping the two content
> pipelines cleanly separated.

Source of record for scope: `Stock_Market_Channel_Project_Plan.docx`
(US stock news, Facebook primary / YouTube secondary, cron-driven, zero daily
manual work at end state).

---

## 0. TL;DR of the decisions I'm recommending

| Question | Decision | Why |
|---|---|---|
| Separate project or inside this app? | **Inside this repo**, as a `stock` workflow alongside `aussie` | Reuses Remotion, Express, TTS, output/Telegram plumbing; one app you open |
| Voice (TTS) | **Prototype with edge-tts, ship with Piper** | edge-tts commercial use **violates Microsoft ToS** — unsafe for a monetized channel. Piper is fully open + commercial-safe. Both are free & run in Node. |
| Market data | **Finnhub for quotes+news; fall back to Financial Modeling Prep (FMP) free if we need real movers/charts** | Finnhub free tier has **no candle/movers endpoint**. FMP free (250 req/day, no card) has dedicated **gainers/losers/most-active + historical charts** in one API. Built as a swappable data layer. |
| LLM | **Google Gemini (Gemini 3 Flash, free tier)**, behind a provider adapter | ~1,500 req/day free, JSON output, easily enough for 2–3 videos/day. Swappable to Claude/Groq. |
| Image library size | **~50 keyword-tagged B-roll images** to start | Enough to cover sectors × sentiment × macro + generic Wall St. Charts are the *primary* visual; library is secondary. |
| Delivery | **Telegram bot** (`sendVideo` + caption), plus local `output/stock/YYYY-MM-DD/` | Matches your "waiting for me" requirement |
| Automation | **Manual button now → node-cron + Windows Task Scheduler later** | Matches the doc's Phase 1→3 progression |

**The single most important finding:** an automated faceless stock-reel channel
is *exactly* the profile YouTube's July-2025 "inauthentic content" policy (enforced
hard in 2026) and Meta's 2026 low-effort-AI rules are built to demonetize. This is
survivable, but only if originality/real-visuals/human-involvement are **designed in
from day one**, not bolted on. See §9 — it's the most important section.

---

## 1. Architecture — one app, two workflows

Build inside the current repo. Shared infra stays; stock-specific code is namespaced.

```
aussie-pipeline/
├─ server/
│  ├─ index.mjs              # existing Express — add /stock/* routes
│  ├─ render.mjs             # existing (aussie)
│  └─ stock/                 # NEW — the stock pipeline
│     ├─ fetch.mjs           #   Finnhub + Yahoo data pull
│     ├─ script.mjs          #   LLM → narration + captions + beat plan
│     ├─ selectImages.mjs    #   keyword match against the library
│     ├─ tts.mjs             #   edge-tts (dev) / Piper (prod) adapter
│     ├─ renderStock.mjs     #   drives the Remotion StockVideo comp
│     ├─ deliver.mjs         #   Telegram + day-folder + index.md
│     └─ pipeline.mjs        #   orchestrates the 5 stages for one day
├─ src/
│  ├─ NostalgiaVideo.jsx     # existing (aussie)
│  └─ StockVideo.jsx         # NEW — chart + ticker + caption template
├─ assets/stock/library/     # NEW — ~50 keyword-named B-roll images
├─ data/stock/
│  ├─ universe.json          # ticker watchlist for movers
│  ├─ ticker-map.json        # ticker → company + image keywords
│  └─ prompts/               # LLM system + few-shot prompts
├─ projects/stock/           # per-day working data (like projects/<slug>)
├─ output/stock/YYYY-MM-DD/  # finished reels + index.md (gitignored)
└─ docs/STOCK_PIPELINE_PLAN.md  # this file
```

Frontend: add a workflow switch at the top of `public/index.html` — **"Aussie
Nostalgia" / "US Stock News"** tabs. Stock tab is much simpler than the Aussie
one: pick the day's reel set (Market Recap / Top Movers / Single-Stock Story),
hit **Generate**, watch the same progress bar, get a link to the day folder +
Telegram confirmation.

---

## 2. The pipeline (5 stages, each independently testable)

Mirrors the doc's Fetch → Script → Render → Deliver → Publish.

1. **Fetch** (`fetch.mjs`)
   - Finnhub `/quote` for each ticker in `universe.json`; compute % change →
     rank → top gainers/losers/most-active.
   - Finnhub `/news?category=general` + `/company-news` for headlines.
   - Yahoo (`yahoo-finance2`) `chart()` for intraday candles of each featured
     ticker (Finnhub free has no candles) → chart data JSON.
   - Cache everything to `projects/stock/<date>/data.json` so re-renders don't
     re-hit the APIs (respects the ~300 calls/day Finnhub limit).

2. **Script** (`script.mjs`)
   - Feed the structured data + the hook/format spec (§5) to Gemini.
   - Returns strict JSON: `{ title, hook, beats:[{caption, vo, ticker,
     sentiment, keywords, chartRef}], cta, disclaimer, fbCaption, ytTitle,
     hashtags }`.
   - One script per reel; 2–3 reels/day.

3. **Render** (`renderStock.mjs` + `StockVideo.jsx`)
   - Primary visual = **live chart + animated ticker + price/%**, the thing that
     makes it "original visuals" for monetization.
   - Secondary = keyword-matched library image behind intro/macro beats.
   - TTS audio from `tts.mjs`; captions timed to VO like the Aussie template.

4. **Deliver** (`deliver.mjs`)
   - Write `.mp4`s to `output/stock/YYYY-MM-DD/` named by type
     (`01_market-recap.mp4`, `02_top-mover-NVDA.mp4`, …).
   - Write `index.md` with, per video: title, one-line brief, full caption,
     hashtags, disclaimer, tickers featured.
   - Push each `.mp4` + caption to Telegram via bot `sendVideo`.

5. **Publish** — manual to Facebook first (per doc). Meta Graph / YouTube Data
   API posting is Phase 3+ and only worth the OAuth review once the format is proven.

---

## 3. Tooling decisions (detail)

### Voice — edge-tts now, Piper for production
- **edge-tts** (`msedge-tts` npm, no Python needed — this machine has no Python):
  great quality, `en-US-ChristopherNeural` / `en-US-AndrewNeural` suit finance
  news. **But**: Microsoft's neural voices via edge-tts are personal-use only;
  using them on a **monetized** channel violates Microsoft's ToS. Fine for
  prototyping the format; do not ship a monetized channel on it.
- **Piper** (self-hosted, MIT-family voices, free, commercial-safe): the
  production voice. Slightly less polished than edge but genuinely licensed for
  commercial use. `tts.mjs` exposes both behind one interface so we swap by a
  `.env` flag once you're happy with the format.

### Market data — Finnhub first, FMP as the upgrade
- **Finnhub free** (default): 60 calls/min, ~300/day, US-only, quotes + news.
  **No candle endpoint**, **no ready movers endpoint** on free — we compute
  movers ourselves from `/quote` across `universe.json`. Good enough to start.
- **Financial Modeling Prep (FMP) free** (secondary — narrower than hoped):
  use the modern **`stable/`** API (the old `api/v3/*` is legacy/deprecated as of
  Aug 2025). Verified free-tier reality Jul 2026: **quotes work** (field is
  `changePercentage`) but **some symbols are premium-locked** (e.g. MU → 402,
  skipped), the native **movers endpoints are dominated by penny stocks /
  leveraged ETFs** (so we rank our own universe instead), and **news is
  premium-only** (degrades to `[]`). Net: FMP free is a *quotes* supplement, not
  a full Finnhub replacement — Finnhub stays the default. `fetch.mjs` keeps a
  **provider interface** so the swap is still a config flag.
- **Cross-check done:** Finnhub and FMP agreed to the cent (NFLX $77.65 / +4.66%,
  TSLA $393.45 / −7.49%) — free-tier prices are trustworthy. (Prices look
  unfamiliar vs. pre-2026 memory because of splits, e.g. Netflix ~$77.)
- **Yahoo (`yahoo-finance2`)** stays available as a no-key chart source if
  needed. All three are validation-phase tools; see §9 for the pre-monetization
  commercial-licensing note (not a concern for a pre-monetization pet project).

### LLM — Gemini free tier
- **Gemini 3 Flash** free tier: ~1,500 requests/day, JSON/structured output,
  1M-token context. 2–3 scripts/day is trivially within limits, $0.
- Behind a thin adapter so it swaps to Claude (the doc budgets $2–10/mo, better
  quality) or Groq (fast, free) without touching the pipeline.

---

## 4. Image library & selection

- Folder: `assets/stock/library/`, ~50 images to start, filenames = keywords
  joined by `-`, e.g.:
  `bull-market-green.jpg`, `bear-crash-red-arrow-down.jpg`,
  `federal-reserve-rates.jpg`, `nvidia-chip-semiconductor.jpg`,
  `oil-energy-barrel.jpg`, `tech-stocks-nasdaq.jpg`, `wall-street-generic.jpg`,
  `trading-floor.jpg`, `earnings-report.jpg`, `crypto-bitcoin.jpg`.
- Coverage grid: **sectors** (tech, energy, finance, healthcare, consumer,
  crypto) × **sentiment** (up/green/bull, down/red/bear, flat) + **macro** (Fed,
  inflation, jobs, oil) + **top ~15 mega-cap** company cues + generic Wall St B-roll.
- `selectImages.mjs`: tokenize each filename on `-`/`_`; score against the beat's
  `keywords` + `tickerName` (via `ticker-map.json`) + `sentiment`; pick best,
  fall back to a sentiment-generic, then to plain Wall-St. Never reuse the same
  image twice in one reel.
- **Framing that matters for monetization**: images are *secondary* B-roll. The
  chart/ticker/price motion is the primary, original visual — that's what keeps
  us out of the "images moving with no real editing" bucket YouTube flags.

---

## 5. Script & hook strategy (what winning finance shorts do)

Structure every reel as **Hook → Stakes → 3 beats → Payoff → CTA → Disclaimer**:

1. **Hook (0–3s)** — lead with the single biggest number, no preamble.
   *"Nvidia added 200 billion dollars in market cap before lunch."*
2. **Stakes/context (3–8s)** — why today mattered in one line.
3. **3 beats** — top movers and/or the day's headline, each a specific
   number + ticker (specificity does the work; charts animate under each).
4. **Payoff/retention twist** — tease the last beat early
   (*"...but the strangest move today was #3"*) to hold watch-time.
5. **CTA** — one soft engagement question (*"Holding any of these?"*).
6. **Disclaimer** — "For information only, not financial advice."

Hard rules (inherit the channel's existing **no-verdict tone**):
- State facts and numbers; **never** "buy/sell", price targets, or predictions.
- Original narration **every day** — vary the opening line, order, and phrasing;
  never a fill-in-the-blank template (this is the monetization line, §9).
- Keep it 30–60s for Reels/Shorts.

---

## 6. Telegram delivery

- BotFather → bot token; get your chat_id. Store `TELEGRAM_BOT_TOKEN` +
  `TELEGRAM_CHAT_ID` in `.env` (already gitignored).
- `deliver.mjs` POSTs each `.mp4` to `sendVideo` with the caption + a summary
  message listing all reels for the day (title + brief).
- No extra deps needed — plain `fetch` to the Bot API.

---

## 7. Daily output (your current "manual button" workflow)

Exactly what you described for now:
- Open app → **US Stock News** tab → choose the day's set → **Generate**.
- Result: `output/stock/2026-07-05/` containing
  - `01_market-recap.mp4`
  - `02_top-mover-NVDA.mp4`
  - `03_headline-fed-rates.mp4`
  - `index.md` — per-video brief, caption, hashtags, disclaimer, tickers.
- Same set pushed to Telegram.
- (These are gitignored by the media rules we just added.)

---

## 8. Automation / cron plan

- **Phase 1 (now):** manual Generate button. Human reviews before posting.
- **Phase 2:** `node-cron` inside the always-on server fires the pipeline after
  US market close (e.g. 4:30pm ET) on weekdays; you still review. On Windows,
  a **Task Scheduler** entry keeps the server running / triggers a headless run.
- **Phase 3:** drop manual review once error rate is low; optionally add Meta
  Graph / YouTube Data API auto-posting (needs OAuth app review).
- Hosting: local is fine to start; Railway/always-on box only if you want it
  running when your PC is off (doc budgets $0–5/mo).

---

## 9. Monetization violations & compliance (the research payoff)

This is the part that actually decides whether the channel earns. Findings:

### A. Facebook originality enforcement — the real gate (primary goal)
Meta's **"Rewarding Original Creators"** update (Mar 2026) matters more than the
10k-followers / 600k-minutes thresholds. The thresholds are the door; originality
is the gate. Specifics for a faceless auto-finance channel:

- **"Limited Originality of Content" (LOC)** is the most damaging strike and is
  **account-wide** — it cuts reach + monetization on *all* posts, not just the
  offending one. But LOC targets **repurposing other people's content** without
  meaningful enhancement. We synthesize **raw market data → original charts +
  original narration**; we never repost someone's clip. This puts us **above**
  the content-farm bucket by design.
- **"Narrating what's already on screen without adding anything meaningful" =
  unoriginal.** This is the trap for us. Reading "NVDA +5%" while that number is
  on screen is exactly it. **Mandatory mitigation, baked into the LLM prompt:**
  every mover beat must add the *why* (factual context/synthesis — "rose 5%
  after its earnings beat"), still no verdict, no advice. That is what converts
  screen-reading into "fresh information and analysis" (Meta's own definition of
  original).
- **"Faceless AI reading a Wikipedia article over stock footage" is explicitly
  non-viable.** We don't do this (real charts as hero visual, synthesized data,
  not article-reading over stock clips) — but must stay visibly far from the
  pattern.
- **Fully faceless is the highest-scrutiny lane**; Meta rewards on-screen creator
  presence. Later mitigations: consistent brand identity/voice, branded
  lower-thirds, possibly a recurring host/on-screen element. Not urgent
  pre-monetization.
- **Near-duplicate suppression** hits your *own* repetitive posts too → the daily
  format variety + a script similarity check keep the 3 reels from reading as clones.

### A2. YouTube "inauthentic content" (secondary platform)
- YouTube renamed "repetitious content" → **"inauthentic content"** (Jul 2025),
  enforced hard in 2026; **channel-wide** enforcement. Same mitigations as above
  apply. Targets faceless compilations, images moving with no real
  narration/editing, and videos identical but for the title.

### A3. Shared mitigations, designed in
  1. **Real chart/ticker visuals** per reel (not static image slideshows).
  2. **Original narration that adds analysis daily** — the *why* per beat, varied
     hook/structure/phrasing (enforced in the LLM prompt + a similarity check).
  3. **Human-in-the-loop** through Phases 1–2 (you review before posting).
  4. **Format variety** across the 2–3 daily reels (recap vs single-stock story
     vs headline), not three clones with different tickers.

### B. TTS licensing
- **edge-tts commercial use = Microsoft ToS violation** (personal use only).
  → ship on **Piper** (commercial-safe) before monetizing. edge-tts for
  prototyping only.

### C. Market-data licensing
- **Finnhub free tier = non-commercial**; a monetized channel is commercial.
  Redistribution needs a paid/commercial plan (contact their sales).
- **Yahoo unofficial API** ToS is grey for commercial use.
  → Before flipping monetization on, either upgrade Finnhub to a commercial
  plan or move to a data source whose terms permit commercial display. During
  the free validation phase (pre-monetization) this is low-risk.

### D. Financial-content compliance
- Fixed **disclaimer** on every video + in captions: "For information/entertainment
  only, not financial advice."
- **Factual recaps only** — no buy/sell calls, price targets, or "this will moon"
  language. (Aligns with the channel's existing no-verdict tone rule.)
- Don't read news articles verbatim (copyright) — summarize facts, attribute source.
- Any background music must be royalty-free/licensed.

### E. Net read
Free tools are fine to **validate the format**. Before you cross a monetization
threshold, budget a small monthly spend to get **legally clean**: Piper (free) +
a commercial data plan + optionally a paid LLM. The bigger risk isn't cost —
it's the inauthentic-content policy, which is a **design constraint**, not a
switch you flip later.

---

## 10. Suggested build order (when you say go)

1. `data/stock/universe.json` + `ticker-map.json` + `fetch.mjs`; prove Finnhub +
   Yahoo pulls and the movers computation on real tickers (doc's Next Step #1).
2. LLM prompt + `script.mjs`; iterate hook/tone on real data (Next Step #2).
3. `StockVideo.jsx` + `renderStock.mjs`; render one test reel end-to-end with
   edge-tts (Next Step #3).
4. `selectImages.mjs` + seed the ~50-image library.
5. `deliver.mjs` (day folder + index.md + Telegram).
6. Frontend tab + Generate button wired to `pipeline.mjs`.
7. Swap TTS to Piper; add node-cron + Task Scheduler (Phase 2).

---

## 11. Open decisions for you

1. **TTS for production:** OK to prototype on edge-tts but plan to ship on Piper?
   (Or pay for ElevenLabs/Azure for best quality?)
2. **Data before monetizing:** upgrade Finnhub to a paid commercial plan, or
   switch data source? (No action needed during free validation.)
3. **Reel set per day:** default I'll assume = **Market Recap + Top Mover +
   one Headline** (3 reels). Adjust?
4. **LLM:** Gemini free to start — agree? (Claude for higher quality later?)
5. **Human review:** keep manual review through Phase 2, or push to full-auto
   sooner (higher demonetization risk)?
