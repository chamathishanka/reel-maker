# Aussie Nostalgia — Video Pipeline

A local tool that turns a script + images + narration into a finished vertical
video in the "Remember Australia" documentary style (Ken Burns pans, year
stamps, captions, engagement outro).

Everything runs on your own machine. Nothing is uploaded anywhere except when
you post the finished .mp4 to Facebook/Instagram yourself.

## One-time setup

Requires [Node.js](https://nodejs.org) 18+ and `ffmpeg` on your PATH (Windows:
`winget install ffmpeg` or download from ffmpeg.org; Mac: `brew install ffmpeg`).

```
npm install
```

## Running it

```
npm run server
```

Then open **http://localhost:4321** in your browser.

1. Create a new project (give it the story's title).
2. Drag and drop your images straight onto the box in step 1 (or click
   "browse"), then drag the cards to reorder — that order becomes the video
   order. Write the caption + year/era for each one directly on the card.
3. Upload your ElevenLabs narration file, and optionally a background music
   track.
4. In step 3, use the timeline to fine-tune how long each slide stays on
   screen against the actual narration waveform. Drag a divider to give a
   slide more or less time — the total always stays locked to the audio
   length. Hit play to preview, click anywhere on the waveform to scrub.
   "Auto-fit to captions" resets it to an automatic split weighted by how
   long each caption is.
5. Add the engagement-prompt line (shown as the last card) and your channel
   name.
6. Click **Save**, then **Generate video**. A progress bar tracks bundling →
   preparing → rendering in real time. The finished .mp4 shows up in the
   preview player and is saved in `output/`.

**Copy captions for ElevenLabs**: once your images are captioned and in the
right order, click "Copy captions for ElevenLabs" at the top of step 1 — it
copies every caption, in your current slide order, as one block of text
separated by blank lines, ready to paste straight into ElevenLabs to generate
the matching narration.

**Focal point**: click anywhere on a slide's thumbnail to drop a small red
crosshair — that's the point the Ken Burns zoom/pan will centre on (e.g. a
face, a car badge, whatever the shot is really about). Defaults to the middle
of the photo if you don't set one.

**On-screen text sizing**: the year/heading is the largest text, centred near
the top; the caption is the second-largest, centred in the lower-middle band
with a wide safe margin from the very bottom and sides (clear of where
Reels/TikTok/Instagram draw their own username, caption, and action-button
overlay). Long captions are automatically split into a few shorter phrases
that appear one after another for as long as that slide is on screen, rather
than being crammed onto one line or shrunk down — both text elements are sized
for an older audience to read comfortably at a glance.

**Voice reminder**: there's a small pinned note under the page title —
"Voice: Charles — Expressive, Mature, Clear" — just a reminder of which
ElevenLabs voice this channel uses, so it stays consistent across videos.

## Included demo

`projects/hills-hoist/` is a working example (script already filled in) and
`output/hills-hoist-DEMO.mp4` shows what the pipeline produces — note the demo
images are plain placeholder cards, not real archival photos, since this is
just to prove the mechanics (Ken Burns, captions, audio sync, outro card) work.
Swap in real photos and it looks like the real thing.

## If video generation fails to find Chrome

Remotion needs a headless Chrome to render frames, and downloads one
automatically the first time you render. If your network blocks that (e.g. a
strict corporate firewall), install this fallback and the pipeline will use it
automatically:

```
npm install @sparticuz/chromium
```

## Project structure

```
src/                  Remotion video template (the "style")
server/               Local backend: uploads, save, render, progress status
public/               Frontend (what opens in your browser)
projects/<slug>/      Your images, audio, and slides.json per story
output/               Rendered .mp4 files land here
data/batch/           3-month content calendar (see below)
```

## Batch / scheduling data

`data/batch/first-90-days.json` is a full first-quarter content calendar
(titles, pillar, hook, suggested source archive, and engagement prompt for
each planned video) generated from the launch plan's posting cadence. Use it
as your production queue — work through it top to bottom, pillar mix is
already balanced per the weekly-mix rule.
