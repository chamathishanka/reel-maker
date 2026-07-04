# Background music tracks

Drop **royalty-free** instrumental tracks here as `.mp3` (or `.m4a`/`.wav`).
The renderer picks one at random per reel and mixes it in *under* the
voiceover at a low background volume (default ~9%, fades in/out).

## Rules
- **Royalty-free / licensed for commercial use only** (e.g. tracks you're
  cleared to use). Keep a note of the source/licence for your own records.
- Instrumental, low-key — it should sit behind narration, not compete with it.
- Any length; longer than a reel is fine (it just gets cut at the end).

## Naming
Filename doesn't matter functionally, but keep it descriptive, e.g.
`calm-corporate-01.mp3`, `ambient-tech-02.mp3`.

## Config (optional, in `.env`)
- `STOCK_MUSIC_VOLUME` — background level, default `0.09`.
- `STOCK_MUSIC_ENABLED=false` — turn music off entirely.

If this folder is empty, reels simply render with no music (voiceover only).
The audio files themselves are gitignored; this README is not.
