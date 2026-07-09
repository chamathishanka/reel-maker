// Stage 3 — RENDER. Turns a day's scripts.json into finished reels:
//   script beats -> per-segment voiceover (edge-tts) -> audio-fitted timeline
//   -> Remotion StockVideo composition -> output/stock/<date>/NN_type.mp4
//
// Bundles the Remotion project once per day and renders each reel off it.

import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';
import {execFile} from 'child_process';
import {promisify} from 'util';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {ROOT, optionalEnv} from './env.mjs';
import {synthesize} from './tts.mjs';
import {generateBeatImage} from './images.mjs';
import {todayStr} from './fetch.mjs';

const execFileP = promisify(execFile);
const PUBLIC_DIR = path.join(ROOT, 'public');
const PROJECTS_DIR = path.join(ROOT, 'projects', 'stock');
const OUTPUT_DIR = path.join(ROOT, 'output', 'stock');
const DATA_DIR = path.join(ROOT, 'data', 'stock');

const CHANNEL_NAME = optionalEnv('STOCK_CHANNEL_NAME', 'Market Minute');
const MUSIC_DIR = path.join(ROOT, 'assets', 'stock', 'music');
const MUSIC_ENABLED = optionalEnv('STOCK_MUSIC_ENABLED', 'true') !== 'false';
const MUSIC_VOLUME = Number(optionalEnv('STOCK_MUSIC_VOLUME', '0.09'));
const FPS = 30;
const SEGMENT_TAIL = 0.35; // seconds of breathing room after each segment's VO

const tickerMap = JSON.parse(
	fs.readFileSync(path.join(DATA_DIR, 'ticker-map.json'), 'utf8'),
);

// Pick a random royalty-free track from assets/stock/music and copy it under
// public/ so Remotion can serve it. Returns a public-relative path or null when
// the folder is empty (reels then render with no music).
function pickMusic(date, publicMusicDir, publicMusicRel) {
	if (!MUSIC_ENABLED || !fs.existsSync(MUSIC_DIR)) return null;
	const tracks = fs
		.readdirSync(MUSIC_DIR)
		.filter((f) => /\.(mp3|m4a|wav|ogg)$/i.test(f));
	if (!tracks.length) return null;
	const chosen = tracks[Math.floor(Math.random() * tracks.length)];
	fs.mkdirSync(publicMusicDir, {recursive: true});
	const dest = path.join(publicMusicDir, chosen);
	if (!fs.existsSync(dest)) fs.copyFileSync(path.join(MUSIC_DIR, chosen), dest);
	return `${publicMusicRel}/${chosen}`;
}

async function resolveBrowserExecutable() {
	try {
		const mod = await import('@sparticuz/chromium');
		const chromium = mod.default || mod;
		return await chromium.executablePath();
	} catch {
		return undefined;
	}
}

async function audioDuration(absPath) {
	const {stdout} = await execFileP('ffprobe', [
		'-v', 'error', '-show_entries', 'format=duration',
		'-of', 'default=noprint_wrappers=1:nokey=1', absPath,
	]);
	return parseFloat(stdout.trim());
}

const slugify = (s) =>
	(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const KNOWN_TICKERS = Object.keys(tickerMap);

// Make VO read naturally: drop spoken ticker symbols ("Netflix, NFLX," / "ticker
// MRNA") — the company name is already said and the symbol shows on the card.
// (Number phrasing is handled upstream in the script prompt.)
function speechFriendly(text) {
	let t = text || '';
	t = t.replace(/,?\s*ticker\s+[A-Za-z]{1,6}\b/gi, '');
	for (const tk of KNOWN_TICKERS) {
		t = t.replace(new RegExp(`,\\s*${tk}\\s*,`, 'g'), ', ');
		t = t.replace(new RegExp(`\\(\\s*${tk}\\s*\\)`, 'g'), '');
	}
	return t.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

// Company name / brand keyword -> ticker, so we can recover the ticker card +
// chart when the LLM leaves a beat's `ticker` field blank (it sometimes does).
const NAME_TO_TICKER = (() => {
	const map = {};
	for (const [tk, info] of Object.entries(tickerMap)) {
		if (info.name) map[info.name.toLowerCase()] = tk;
		// first keyword is the brand (e.g. "apple", "netflix", "arm")
		if (info.keywords?.[0]) map[info.keywords[0].toLowerCase()] = tk;
	}
	return map;
})();

// Resolve a beat to a ticker that has a live quote: use the explicit field if
// present, else infer from the beat's keywords / caption / vo.
function resolveTicker(beat, quotesByTicker) {
	if (beat.ticker && quotesByTicker[beat.ticker.toUpperCase()]) {
		return beat.ticker.toUpperCase();
	}
	const hay = `${(beat.keywords || []).join(' ')} ${beat.caption || ''} ${beat.vo || ''}`.toLowerCase();
	// Prefer longer names first (e.g. "arm holdings" before "arm").
	const names = Object.keys(NAME_TO_TICKER).sort((a, b) => b.length - a.length);
	for (const name of names) {
		const tk = NAME_TO_TICKER[name];
		if (!quotesByTicker[tk]) continue;
		if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay)) {
			return tk;
		}
	}
	return '';
}

// Build the ordered segment list (before audio) for one reel script.
function planSegments(script, quotesByTicker, movers, weekly = false) {
	const segments = [];
	const firstSentiment = script.beats?.[0]?.sentiment || 'up';

	segments.push({kind: 'hook', vo: script.hook, text: script.hook, sentiment: firstSentiment});

	// A brief "market board" table (top movers + prices) on the recap reel only.
	if (script.type === 'market-recap' && movers) {
		const rows = boardRows(movers);
		if (rows.length) {
			segments.push({
				kind: 'board',
				vo: weekly ? "Here's how this week's movers stack up." : "Here's how today's movers stack up.",
				sentiment: 'neutral',
				rows,
			});
		}
	}

	for (const beat of script.beats) {
		const ticker = resolveTicker(beat, quotesByTicker);
		const q = ticker ? quotesByTicker[ticker] : null;
		if (q && typeof q.price === 'number') {
			segments.push({
				kind: 'beat',
				vo: beat.vo,
				caption: beat.caption,
				ticker,
				name: q.name || tickerMap[ticker]?.name || '',
				price: q.price,
				changePct: q.changePct,
				sentiment: beat.sentiment,
				keywords: beat.keywords,
			});
		} else {
			// Genuinely tickerless (macro/market-wide) beat — statement card.
			segments.push({kind: 'hook', vo: beat.vo, text: beat.caption || beat.vo, sentiment: beat.sentiment});
		}
	}

	segments.push({kind: 'cta', vo: script.cta, text: script.cta, sentiment: 'neutral'});
	return segments;
}

// Top gainers + losers as compact board rows (ticker, price, % ).
function boardRows(movers) {
	const pick = (arr) =>
		(arr || []).slice(0, 3).map((q) => ({
			ticker: q.ticker,
			price: q.price,
			changePct: q.changePct,
		}));
	return [...pick(movers.gainers), ...pick(movers.losers)];
}

// Synthesize VO per segment (fit frames to audio) and generate a backdrop image
// for each content beat. Sequential by design — the free image service
// (Pollinations) rate-limits concurrent requests per IP (429s), so running
// these in parallel causes MORE failures/gradient-fallbacks, not fewer. No
// rush: correctness and image quality matter more than shaving a minute.
async function prepareSegments(segments, dirs, reelSlug, onSegment) {
	const {audioDir, publicAudioRel, imageDir, publicImageRel} = dirs;
	fs.mkdirSync(audioDir, {recursive: true});
	const out = [];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const idx = String(i).padStart(2, '0');

		const audioFile = `${reelSlug}-${idx}.mp3`;
		const spoken = speechFriendly(seg.vo || seg.text || '.');
		onSegment?.({index: i, total: segments.length, phase: 'voice'});
		const {wordBoundaries} = await synthesize(spoken, path.join(audioDir, audioFile));
		const dur = await audioDuration(path.join(audioDir, audioFile));
		// Real per-word timings for karaoke captions; estimate if the engine
		// didn't provide them (e.g. ElevenLabs).
		const words = wordBoundaries?.length ? wordBoundaries : estimateWords(spoken, dur);

		// Every segment gets a dimmed backdrop image (no more flat-black hook/cta).
		// Beats use their stock's sector; hook/cta use generic "markets" scenes.
		const sector = seg.kind === 'beat' ? tickerMap[seg.ticker]?.sector || 'markets' : 'markets';
		onSegment?.({index: i, total: segments.length, phase: 'image'});
		const img = await generateBeatImage({
			sector,
			sentiment: seg.sentiment,
			variant: i,
			cacheKey: `${reelSlug}-${idx}`,
			outDir: imageDir,
		});
		const image = img ? `${publicImageRel}/${img.fileName}` : undefined;

		out.push({
			...seg,
			audio: `${publicAudioRel}/${audioFile}`,
			image,
			words,
			durationInFrames: Math.max(1, Math.round((dur + SEGMENT_TAIL) * FPS)),
		});
	}
	return out;
}

// Fallback word timing: distribute the audio duration across words weighted by
// length, so captions still track speech when no real boundaries are available.
function estimateWords(text, dur) {
	const tokens = (text || '').trim().split(/\s+/).filter(Boolean);
	if (!tokens.length) return [];
	const weights = tokens.map((w) => Math.max(2, w.length));
	const total = weights.reduce((a, b) => a + b, 0);
	let t = 0;
	return tokens.map((w, i) => {
		const d = (weights[i] / total) * dur;
		const start = t;
		t += d;
		return {text: w, start, duration: d};
	});
}

export async function renderDay({date = todayStr(), onProgress} = {}) {
	const dayDir = path.join(PROJECTS_DIR, date);
	const scriptsPath = path.join(dayDir, 'scripts.json');
	const dataPath = path.join(dayDir, 'data.json');
	if (!fs.existsSync(scriptsPath)) {
		throw new Error(`No scripts.json for ${date}. Run script.mjs first.`);
	}
	const {scripts} = JSON.parse(fs.readFileSync(scriptsPath, 'utf8'));
	const marketData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
	const quotesByTicker = Object.fromEntries(
		marketData.quotes.map((q) => [q.ticker.toUpperCase(), q]),
	);

	// Audio + images live under public/ so Remotion's staticFile can serve them.
	const publicDayDir = path.join(PUBLIC_DIR, 'projects', 'stock', date);
	const dirs = {
		audioDir: path.join(publicDayDir, 'audio'),
		publicAudioRel: `projects/stock/${date}/audio`,
		imageDir: path.join(publicDayDir, 'images'),
		publicImageRel: `projects/stock/${date}/images`,
	};
	const publicMusicDir = path.join(publicDayDir, 'music');
	const publicMusicRel = `projects/stock/${date}/music`;

	const outDir = path.join(OUTPUT_DIR, date);
	fs.mkdirSync(outDir, {recursive: true});

	// Pass 1: synthesize all voiceover into public/ BEFORE bundling. Remotion's
	// bundle() snapshots public/ at bundle time, so every asset a render will
	// request must already exist on disk when we bundle (see CLAUDE.md gotcha).
	const reels = [];
	for (let r = 0; r < scripts.length; r++) {
		const script = scripts[r];
		const num = String(r + 1).padStart(2, '0');
		const topTicker = script.beats?.find((b) => b.ticker)?.ticker;
		const reelSlug = slugify(`${script.type}${topTicker ? `-${topTicker}` : ''}`);

		onProgress?.({stage: 'voicing', reel: r + 1, of: scripts.length, type: script.type});
		const planned = planSegments(script, quotesByTicker, marketData.movers, marketData.mode === 'weekly');
		const segments = await prepareSegments(planned, dirs, `${num}-${reelSlug}`, (s) =>
			onProgress?.({
				stage: 'voicing',
				reel: r + 1,
				of: scripts.length,
				type: script.type,
				segment: s.index + 1,
				segments: s.total,
				phase: s.phase,
			}),
		);

		const musicAudio = pickMusic(date, publicMusicDir, publicMusicRel);

		reels.push({
			script,
			reelSlug,
			num,
			data: {
				fps: FPS,
				width: 1080,
				height: 1920,
				channelName: CHANNEL_NAME,
				disclaimer: script.disclaimer,
				date,
				weekly: marketData.mode === 'weekly',
				type: script.type,
				title: script.title,
				segments,
				musicAudio,
				musicVolume: MUSIC_VOLUME,
			},
		});
	}

	// Pass 2: bundle once (now that all audio exists), then render each reel.
	onProgress?.({stage: 'bundling'});
	const bundleLocation = await bundle({entryPoint: path.join(ROOT, 'src', 'index.jsx'), onProgress: () => {}});
	const browserExecutable = await resolveBrowserExecutable();

	const results = [];
	for (let r = 0; r < reels.length; r++) {
		const {script, reelSlug, num, data} = reels[r];

		onProgress?.({stage: 'selecting-composition', reel: r + 1});
		const composition = await selectComposition({
			serveUrl: bundleLocation,
			id: 'StockVideo',
			inputProps: {data},
			browserExecutable,
			chromiumOptions: {ignoreCertificateErrors: true, disableWebSecurity: true},
		});

		const outputFileName = `${num}_${reelSlug}.mp4`;
		const outputLocation = path.join(outDir, outputFileName);

		onProgress?.({stage: 'rendering', reel: r + 1, of: scripts.length, progress: 0});
		await renderMedia({
			composition,
			serveUrl: bundleLocation,
			codec: 'h264',
			outputLocation,
			inputProps: {data},
			browserExecutable,
			chromiumOptions: {ignoreCertificateErrors: true, disableWebSecurity: true},
			onProgress: ({progress}) => onProgress?.({stage: 'rendering', reel: r + 1, of: scripts.length, progress}),
		});

		const tickers = [...new Set(data.segments.filter((s) => s.ticker).map((s) => s.ticker))];
		results.push({
			type: script.type,
			title: script.title,
			outputFileName,
			outputLocation,
			hook: script.hook,
			cta: script.cta,
			fbCaption: script.fbCaption,
			hashtags: script.hashtags,
			disclaimer: script.disclaimer,
			tickers,
			data,
		});
	}

	// Persist the resolved reels (everything the delivery step needs) for reference.
	fs.writeFileSync(
		path.join(dayDir, 'reels.resolved.json'),
		JSON.stringify(
			{
				date,
				results: results.map((x) => ({
					type: x.type,
					title: x.title,
					file: x.outputFileName,
					hook: x.hook,
					cta: x.cta,
					fbCaption: x.fbCaption,
					hashtags: x.hashtags,
					disclaimer: x.disclaimer,
					tickers: x.tickers,
					segments: x.data.segments,
				})),
			},
			null,
			2,
		),
	);

	return {date, outDir, results};
}

// CLI: `node server/stock/renderStock.mjs [YYYY-MM-DD]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const date = process.argv[2] || todayStr();
	renderDay({date, onProgress: (p) => console.log(JSON.stringify(p))})
		.then((r) => {
			console.log(`\nRendered ${r.results.length} reel(s) to ${r.outDir}:`);
			r.results.forEach((x) => console.log(`  ${x.outputFileName}  (${x.type})`));
		})
		.catch((err) => {
			console.error(`\n[renderStock] ${err.stack || err.message}\n`);
			process.exit(1);
		});
}
