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
const FPS = 30;
const SEGMENT_TAIL = 0.35; // seconds of breathing room after each segment's VO

const tickerMap = JSON.parse(
	fs.readFileSync(path.join(DATA_DIR, 'ticker-map.json'), 'utf8'),
);

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

// Look up live price/%/name for a ticker from the day's fetched quotes.
function quoteFor(ticker, quotesByTicker) {
	if (!ticker) return null;
	return quotesByTicker[ticker.toUpperCase()] || null;
}

// Build the ordered segment list (before audio) for one reel script.
function planSegments(script, quotesByTicker) {
	const segments = [];
	const firstSentiment = script.beats?.[0]?.sentiment || 'up';

	segments.push({kind: 'hook', vo: script.hook, text: script.hook, sentiment: firstSentiment});

	for (const beat of script.beats) {
		const q = quoteFor(beat.ticker, quotesByTicker);
		if (q && typeof q.price === 'number') {
			segments.push({
				kind: 'beat',
				vo: beat.vo,
				caption: beat.caption,
				ticker: beat.ticker.toUpperCase(),
				name: q.name || tickerMap[beat.ticker.toUpperCase()]?.name || '',
				price: q.price,
				changePct: q.changePct,
				sentiment: beat.sentiment,
				keywords: beat.keywords,
			});
		} else {
			// No resolvable ticker (macro/market-wide beat) — show it as a
			// statement card using the caption, still voiced by its VO.
			segments.push({kind: 'hook', vo: beat.vo, text: beat.caption || beat.vo, sentiment: beat.sentiment});
		}
	}

	segments.push({kind: 'cta', vo: script.cta, text: script.cta, sentiment: 'neutral'});
	return segments;
}

// Synthesize VO per segment (fit frames to audio) and generate a backdrop image
// for each content beat. Both write under public/ before bundling.
async function prepareSegments(segments, dirs, reelSlug) {
	const {audioDir, publicAudioRel, imageDir, publicImageRel} = dirs;
	fs.mkdirSync(audioDir, {recursive: true});
	const out = [];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const idx = String(i).padStart(2, '0');

		const audioFile = `${reelSlug}-${idx}.mp3`;
		await synthesize(speechFriendly(seg.vo || seg.text || '.'), path.join(audioDir, audioFile));
		const dur = await audioDuration(path.join(audioDir, audioFile));

		// Every segment gets a dimmed backdrop image (no more flat-black hook/cta).
		// Beats use their stock's sector; hook/cta use generic "markets" scenes.
		const sector = seg.kind === 'beat' ? tickerMap[seg.ticker]?.sector || 'markets' : 'markets';
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
			durationInFrames: Math.max(1, Math.round((dur + SEGMENT_TAIL) * FPS)),
		});
	}
	return out;
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
		const planned = planSegments(script, quotesByTicker);
		const segments = await prepareSegments(planned, dirs, `${num}-${reelSlug}`);

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
				type: script.type,
				title: script.title,
				segments,
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
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
