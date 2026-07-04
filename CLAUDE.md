# Aussie Nostalgia Video Pipeline — Project Context

This file exists so Claude Code has full context picking up development on this
project. It summarizes everything decided and built in the prior session
(done in Claude/Cowork, not Claude Code) so you don't have to re-explain it.

## What this is

A local tool for "Remember Australia" (working name, other options considered:
*The Aussie Archive*, *Back Then, Australia*, *Sepia & Southern Cross*) — a
Facebook/Instagram nostalgia channel. The tool turns a script + images +
narration into a finished vertical (1080x1920) documentary-style video:
Ken Burns pans/zooms, year-stamp heading, timed captions, quiet
instrumental/period music, engagement outro card. Everything runs locally —
nothing is uploaded anywhere except when the user posts the finished .mp4
themselves.

**Tone rule for all content** (this matters for anything content-related, not
just code): narration/captions state facts, never a verdict on whether
something was good/bad/right/wrong. Let specificity do the emotional work.

## Stack / architecture

- **Backend**: Node + Express (`server/index.mjs`) — project CRUD, file
  uploads (multer), ffmpeg/ffprobe calls (audio duration + waveform PNG
  generation), and a fire-and-forget `/generate` endpoint + `/generate/status`
  polling endpoint for progress tracking (in-memory `jobs` object keyed by
  project slug — fine for a single-user local tool, no DB).
- **Render engine**: Remotion 4.x, driven programmatically from
  `server/render.mjs` via `@remotion/bundler` (`bundle()`) +
  `@remotion/renderer` (`selectComposition()` + `renderMedia()`). Every render
  call bundles fresh — no caching shortcuts in the shipped code (that's
  important, see "gotchas" below).
- **Video template**: `src/NostalgiaVideo.jsx` — the actual visual design.
  This is the file that gets edited most.
- **Frontend**: plain HTML/CSS/vanilla JS (`public/index.html`, `app.js`,
  `styles.css`) — no framework, no build step, served directly by Express.
- **Per-project data**: `projects/<slug>/slides.json` (+ `images/`, `audio/`
  subfolders). `slides.resolved.json` gets written after a render with the
  final (possibly auto-fitted) durations, for reference.
- **Content calendar**: `data/batch/first-90-days.json` — 87 pre-planned
  video entries across the first 13 weeks (see "Content strategy" below).

## Current design of `src/NostalgiaVideo.jsx` (as of last session)

This went through several rounds of correction — here's the **current,
correct** state, not the history of mistakes:

- **`YearStamp` component**: plain sans-serif (`Helvetica, Arial, sans-serif`),
  `fontWeight: 400` (not bold), `fontSize: 82`, color `#d8d3c8` (light warm
  grey, not bright cream), positioned via
  `<AbsoluteFill style={{alignItems:'center', top:'34%'}}>` — i.e. **centred
  in the middle-upper area of the screen, not at the very top**. This was
  explicitly requested by the user after an earlier wrong attempt put it at
  the top in a bold serif font — don't revert this styling without the user
  asking.
- **`TimedCaption` component**: `Georgia, serif`, `fontWeight: 600`,
  `fontSize: 66`, `maxWidth: 940`, centred, positioned via
  `<AbsoluteFill style={{alignItems:'center', justifyContent:'flex-end',
  paddingBottom: 480}}>` (this paddingBottom is what controls "how high up"
  it sits — started at 300, was too close to the bottom/got cut off by
  platform UI, corrected to 480). Long captions auto-split into chunks
  (`splitCaptionIntoChunks`, `maxChars = 38`) that display one at a time,
  each getting screen time proportional to its length within the slide's
  duration (with a 1.1s floor per chunk), with a short cross-fade between
  chunks. This was a deliberate design choice ("it's okay to break a caption
  into parts") specifically so text is never cramped or shrunk for an older
  target audience.
- **`KenBurnsSlide` component**: reads `slide.focalX` / `slide.focalY`
  (0–100, default 50/50) and applies them as `transformOrigin` on the scaled
  `<Img>` — this is what makes the Ken Burns zoom/pan centre on whatever
  point the user clicked on the thumbnail in the frontend, instead of always
  the image's geometric centre.
- **`EngagementOutro` component**: last card of the video, shows
  `engagementPrompt` + `channelName`.
- Frame-fade in/out between slides (`FRAME_FADE = 12`), sepia/contrast filter
  on images, dark gradient vignette overlay (top+bottom) for text legibility.

**Do not re-introduce**: a separate top-left corner year badge, or a second
year element anywhere. There is exactly one `YearStamp` usage in the file
(inside `NostalgiaVideo`'s slide-mapping loop) — keep it that way.

## Frontend features (all built and working)

1. **Drag-and-drop image upload**: drop files directly onto `#dropZone`
   (distinguishes OS file drops via `e.dataTransfer.types.includes('Files')`
   from internal card-reorder drags, which use native HTML5 `draggable`).
2. **Click-to-set focal point**: click anywhere on a slide's thumbnail to
   drop a crosshair marker (`.focal-marker` CSS, positioned by
   `slide.focalX/focalY`); this is what `KenBurnsSlide` reads at render time.
3. **Waveform timeline** (section 3 in the UI): on narration upload, the
   backend generates a waveform PNG via
   `ffmpeg -filter_complex showwavespic=s=1600x160:colors=#c9a24b`. The
   frontend shows it with draggable dividers between slides — dragging one
   steals time from a neighbouring slide (total always stays locked to the
   narration length), plus a play button with a synced moving playhead and
   click-to-seek. "Auto-fit to captions" button resets to the automatic
   caption-length-weighted split (`weightedAutoFitDurations()` in `app.js`,
   mirrors the server-side algorithm in `render.mjs`).
4. **Generation progress bar**: `POST /generate` returns immediately
   (`{started:true}`); frontend polls `GET /generate/status` every 700ms and
   updates a progress bar through stages: bundling → selecting-composition →
   rendering (0–100%) → done.
5. **Copy captions for ElevenLabs**: button joins all slide captions (in
   current order) with blank-line separators and copies to clipboard via
   `navigator.clipboard.writeText`.
6. **Voice reminder note**: static pinned text under the page title —
   "Voice: Charles — Expressive, Mature, Clear" — just a reminder of which
   ElevenLabs voice this channel uses. Not project-specific data, just a UI
   note.
7. **Import captions from JSON** (section 1 header): "Import captions (JSON)"
   reads a file and applies it to slides *in order* via `applyCaptionsJson()`
   in `app.js`. Each entry supplies `caption`, `year`/`header`,
   `duration`/`length`, and `kenBurns`/`effect`/`motion` (friendly spellings
   like "Zoom in" / "pan_left" are normalised by `normalizeKenBurns`). Existing
   images/focal points are preserved; if the list is longer than the current
   slides, extra image-less slides are created (so you can import a full script
   first, then attach photos per card). Accepts a bare array or `{slides:[…]}`
   /`{captions:[…]}`/`{sections:[…]}`. "Download template" emits a sample file.
8. **Per-card image replace**: each slide card has a "Replace image" button and
   accepts an image *dropped directly onto its thumbnail* (the thumb's drop
   handler calls `e.stopPropagation()` so it doesn't bubble to `#dropZone`,
   which would otherwise append a new slide). Both go through
   `replaceSlideImage(index, file)`, which uploads and repoints `slide.image`.
9. **Captions shown on the timing timeline** (section 3): each waveform segment
   now renders its slide number + caption text overlaid, and the labels row
   under it shows duration + a 3-line caption clamp, so timing can be aligned
   to what's actually being said. Typing a caption in a card live-updates the
   timeline text via `updateTimelineCaption()` without a full re-render.

The UI was given a "premium" pass (sticky blurred header, gradient gold
accents, card hover lift, refined timeline) — all in `styles.css`; class hooks
are unchanged, so `app.js` selectors still match. The focal-point crosshair
marker was also made more visible (ring + longer crosshair) since the user
reported it felt like it "wasn't working".

## Known gotchas from the dev sandbox (do NOT carry these into real dev)

These only applied to the constrained sandbox the previous session was built
in — they should NOT matter in a normal VS Code / local machine setup, but
noting them in case something looks odd:

- The dev sandbox had a broken/FUSE-backed filesystem for the output folder
  that silently truncated large file writes and blocked deletes — this is
  why some files were rewritten via heredocs instead of normal edits. Not
  relevant to a real filesystem.
- The sandbox's headless Chrome download (Remotion needs this to render) was
  blocked by network allowlisting, so `server/render.mjs` has a defensive,
  optional fallback: it tries `import('@sparticuz/chromium')` and uses its
  bundled Chromium binary if present, silently no-ops otherwise. This is
  harmless to keep, but a normal machine with internet access won't need it
  — Remotion's own auto-download of Chrome Headless Shell should just work.
- **Real bug worth knowing about**: Remotion's `bundle()` takes a snapshot
  copy of the `public/` folder at bundle time. If you ever add caching logic
  that reuses an old bundle across renders (the shipped `render.mjs` does
  NOT do this — it bundles fresh every time), stale images can get served
  even after the source files change. This caused a confusing "duplicate
  year" bug during testing (leftover debug text baked into placeholder test
  images, served from a stale bundle snapshot) — fully resolved in the
  shipped code, just don't add bundle caching without being careful about
  this.

## Content strategy context (for anything calendar/script related)

- **Market**: Australia first, not Canada/UK — reasoning was less creator
  competition in this specific niche, a distinctive/non-generic visual
  vocabulary, and a smaller audience that's cheaper to validate with before
  a planned Phase 2 UK clone (bigger audience, more competitive).
- **Content pillars**: A) everyday material nostalgia, B) historical/
  political (measured, no-verdict narration), C) war & national service,
  D) natural disasters & sport. Weekly mix guideline: 2A/2B/1C/1D as a
  baseline per week.
- **Avoid for first 90 days**: 1967 referendum, Mabo decision, Voice
  referendum, Cronulla riots, Stolen Generations — not off-limits forever,
  just high mass-report/misrepresentation risk if narration tips into
  interpretation; revisit later with extra scrutiny if at all.
- `data/batch/first-90-days.json` has all 87 entries already planned
  (week, pillar, title, hook, suggested source archive, engagement prompt)
  covering weeks 1–13 (validate phase weeks 1–4, build phase weeks 5–13),
  with verified real dates for the historical/war/disaster entries.

## Included demo project

`projects/hills-hoist/` — fully filled-in example (captions, years, Ken
Burns directions, engagement prompt). Images are flat-colour placeholder
cards (no real photos, since this is just to prove the render mechanics),
audio is a placeholder tone, not real narration. `output/hills-hoist-DEMO.mp4`
is a real render straight out of this pipeline in its current state.

## Running it

```
npm install
npm run server
```
Then open `http://localhost:4321`.

## Likely next steps (not yet requested, just plausible follow-ups)

- Real photos + real ElevenLabs narration for the first actual video.
- Working through `data/batch/first-90-days.json` as a production queue.
- Possibly: per-chunk manual caption-timing override in the UI (currently
  automatic only), a waveform for the music track too, or batch-queuing
  multiple projects through `/generate` sequentially.
