# Caption Studio — Product & Build Plan

> **This is a plan for a SEPARATE product**, not the stock-reel pipeline. It's
> staged here for convenience — **move it into a new repo/folder** before you
> start (see "How to build this with Claude Code" at the bottom).
>
> Working name: **Caption Studio** (rename freely).

---

## 1. Thesis (why this exists now)

CapCut moved auto-captions, styled/animated captions, watermark-free export, and
effects **behind Pro (~$20/mo)** in 2026, and users are actively looking for a
replacement (competitors publish "CapCut captions aren't free anymore" articles).
The subscription alternatives (Submagic, Captions.ai, Veed, Descript, ZapCap) are
**cloud + subscription**.

**The gap nobody in that race owns: local + one-time + offline.**

> **Product in one line:** *"The captions tool CapCut users wanted before the
> paywall — runs on your machine, pay once, no subscription, no watermark,
> unlimited."*

What makes the economics work: bundle **open-source AI that runs on the user's
own hardware** → zero marginal cost per user → a one-time price is sustainable,
and it's genuinely private/offline.

---

## 2. Target user & core value

- **Primary:** budget-conscious short-form creators fleeing CapCut's paywall; the
  large "I hate subscriptions" crowd; privacy-sensitive users (files never leave
  the machine — real for legal/medical/corporate).
- **Core value:** drag in a video → get accurate, **beautifully animated**
  word-by-word captions → export with no watermark, unlimited, offline. Paid once.

---

## 3. Scope — be ruthless

**IN (v1):** auto-caption arbitrary user videos, edit the transcript + timing,
apply animated caption styles, preview, export burned-in (no watermark), batch.

**OUT (v1) — do NOT build these:**
- **A general video editor** (timeline, layers, effects, transitions). CapCut is
  *free* and excellent at this — you cannot win here. This is an **AI caption
  tool**, not an NLE.
- **AI voiceover** — deferred to v2 as an *optional download* (see §8). Captions
  are what the demand pool is searching for; voiceover is a nice-to-have and
  local TTS is "good, not ElevenLabs-amazing." Don't let it bloat or delay v1.
- Cloud anything. The whole pitch is local.

---

## 4. v1 feature spec

1. **Import** — drag-drop a video (mp4/mov/etc.). Show it in a preview player.
2. **Transcribe** — local **Whisper** → word-level timestamps. Progress bar;
   model runs on-device (offline).
3. **Edit** — an editable transcript panel: fix mis-heard words, split/merge
   caption lines, nudge timing. Changes reflect live in preview.
4. **Style** — a set of **animated caption templates** (this is the premium
   feature CapCut paywalled): karaoke word-highlight, pop/scale, current-word
   color, position, font, size, outline/shadow, max words per line. Ship
   ~5–8 polished presets + basic customization.
5. **Preview** — scrub with captions rendered live.
6. **Export** — burn captions into the video via the render engine; **no
   watermark**; resolution options (720/1080/4k); pick format.
7. **Batch** — queue multiple videos with the same style, export overnight.

Nice-to-have (v1.1): translate captions, export `.srt`/`.ass` sidecar, speaker
labels, auto-punctuation toggle, profanity filter.

---

## 5. Tech stack & the ONE decision that matters most

### Desktop shell
- **Tauri** (Rust core, tiny installer, uses the OS webview) — recommended for a
  lean install that matches the "lightweight local" pitch.
- **Electron** (bundles Chromium, ~100MB+, but more mature/examples) — fallback
  if the team is more comfortable in pure JS.

### Speech-to-text (the core)
- **whisper.cpp** (bundled C++ binary + GGUF model) — recommended: no Python
  runtime to ship, easy to bundle, good CPU perf, optional GPU. Default to a
  **base/small** model (~140–460MB); let users download **medium/large** for
  accuracy.
- Alternative: **faster-whisper** (Python/CTranslate2) — faster on GPU but drags
  in a Python runtime → heavier packaging.

### Caption rendering — **the #1 architectural decision, prototype this FIRST**
The premium look (animated captions) is the whole selling point, so how you
render it defines the product:

| Option | Look | Weight / speed | Notes |
|---|---|---|---|
| **Remotion** (reuse our component) | **Best** — springs, scale, per-word color, anything | Heavy: bundles Chrome (~150–300MB), renders frame-by-frame (slower) | Fastest path to a *polished* result; we already built the karaoke component |
| **ffmpeg + libass (ASS subtitles)** | Good karaoke/basic animation, not fancy | **Light + fast** (near real-time burn) | Great for speed/size; ceiling on "wow" animations |
| **Custom canvas/WebGL overlay → composite with ffmpeg** | Very good, full control | Medium | Most engineering; best long-term |

**Recommendation:** prototype **Remotion first** (reuse existing work → looks
premium immediately) to validate the product, and add a **"fast export" mode via
libass** for speed/batch. Long term, a custom canvas renderer removes the Chrome
dependency. **Whichever you pick, spike it in week 1** — it gates everything.

### Model management
Ship a small default model; offer larger models + (later) voice packs as
**optional in-app downloads** so the base installer stays lean.

### Licensing & payments
- **Gumroad** or **Lemon Squeezy** (handles payments, VAT, and license keys).
- Simple license-key check on activation. Don't over-engineer anti-piracy early.

### Updates
Auto-update (Tauri/Electron both support it) — needed because platform rules and
models evolve.

---

## 6. Reusable assets from the stock-reel repo

Bring these as **references**, not a fork:
- **The animated caption component** (`src/StockVideo.jsx` → `WordCaptions`,
  `HookCard`): the karaoke word-highlight logic + styling. This is the biggest
  head start — it's literally the paywalled feature, already built.
- **TTS engine abstraction** (`server/stock/tts.mjs`): the swap-able engine
  pattern (edge/eleven/piper) — useful when voiceover lands in v2.
- **Remotion render driver pattern** (`server/stock/renderStock.mjs`): how to
  bundle + render programmatically, if you go the Remotion route.

Everything else (data fetch, LLM scripts, finance logic) is irrelevant here.

---

## 7. Build order (MVP-first)

1. **Spike the renderer decision** (Remotion vs libass) with the existing
   karaoke component on one hard-coded caption track. Decide.
2. **Local Whisper integration**: video in → word-level transcript out, in the
   desktop shell. This is the core risk — prove it early.
3. **Transcript edit UI** + live preview.
4. **Caption style presets** (port/adapt the karaoke component; 5–8 presets).
5. **Export** (no watermark, resolutions) + **batch** queue.
6. **Onboarding** (first-run, model download) + **licensing** (Gumroad/LS).
7. **Package + auto-update**; test on clean Windows/Mac machines.
8. Polish, landing page, launch.

---

## 8. v2+ (after launch)

- **AI voiceover** as an *optional voice-pack download*: **Piper** first (tiny,
  MIT, commercial-safe) + a **"bring your own ElevenLabs key"** toggle for
  premium quality without bundling anything. (Keeps base app lean.)
- Translation / multi-language captions.
- More templates (a paid template pack could be a light recurring revenue add).
- Vertical presets (podcast clips, tutorials, reels).

---

## 9. Risks & honest caveats

1. **It's a race.** Many tools are chasing CapCut's abandoned free users. Your
   defensible lane is *specifically* local + one-time + offline + no-watermark —
   stay in it; don't drift into "another editor."
2. **Model size / performance** varies by machine; weak CPUs transcribe slowly.
   Offer model-size tiers and set expectations.
3. **Cross-platform packaging** (Whisper binary, GPU accel, ffmpeg, Chrome if
   Remotion) is fiddly — budget real time for Windows + Mac builds.
4. **Quality bar.** It must *look* as good as the $20/mo tools or the "pay once"
   pitch won't hold. The animated captions are how you clear that bar.
5. **Maintenance vs one-time revenue.** Consider **paid major versions** (v1→v2)
   so ongoing upkeep is funded without a subscription.

---

## 10. Business snapshot

- **Positioning:** intercept "CapCut captions not free anymore" searches directly.
- **Price:** ~**$29–79 one-time** (undercuts $200–480/yr subs — the framing sells
  itself). Optional paid template packs / v2 upgrade later.
- **Sell via:** Gumroad / Lemon Squeezy.
- **Marketing:** side-by-side "$0/mo vs their $30/mo", the privacy/offline angle,
  no-watermark + unlimited, and short demos of the animated captions.

---

## How to build this with Claude Code (setup)

1. **New folder, new git repo** (e.g. `caption-studio/`). Do NOT build inside the
   stock-reel repo — clean context makes Claude much sharper.
2. Move **this doc** into it.
3. Copy the **caption component** file from the stock repo in as a *reference*.
4. Start a **fresh Claude Code chat in the new folder**, run `/init` to generate a
   focused `CLAUDE.md`, then point it at this plan and start with **Build step 1
   (the renderer spike)**.
5. First real question to resolve with Claude: **Tauri vs Electron** and
   **Remotion vs libass** — those two choices shape everything else.
