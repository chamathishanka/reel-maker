// Stage 4 — IMAGES. Generates a fresh, on-theme B-roll backdrop per beat each
// day via Pollinations (free, no key). Prompts are abstract sector/mood scenes
// — no logos, no text, no real faces — so they're safe decorative visuals.
// Cached per day; any failure returns null so StockVideo falls back to its
// sentiment gradient (a bad Pollinations day never breaks a render).

import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';
import {optionalEnv} from './env.mjs';

const MODEL = optionalEnv('POLLINATIONS_MODEL', 'flux');
const TIMEOUT_MS = 45000;

// Sector -> several distinct scenes (kept generic; never a company/brand) so
// consecutive same-sector beats don't render near-identical images.
const SECTOR_SCENE = {
	tech: [
		'a sleek modern data center with rows of glowing servers',
		'an extreme close-up of a circuit board with glowing traces',
		'a futuristic server-room corridor bathed in cool light',
	],
	finance: [
		'a financial district of glass skyscrapers at blue hour',
		'a grand marble bank hall with tall columns',
		'a downtown skyline reflected in still water at dusk',
	],
	energy: [
		'an oil refinery lit up against a dusk sky',
		'an offshore oil rig silhouetted on the horizon',
		'rows of industrial pipelines and storage tanks',
	],
	healthcare: [
		'a modern pharmaceutical lab with rows of glass vials',
		'a close-up of medicine vials on a production line',
		'a sterile research laboratory with glowing equipment',
	],
	consumer: [
		'a modern retail storefront glowing at night',
		'a bustling shopping mall interior after hours',
		'neatly stacked consumer products on bright shelves',
	],
	industrial: [
		'a heavy industrial factory floor with machinery',
		'sparks flying in a metal foundry',
		'a vast warehouse of stacked shipping containers',
	],
	markets: [
		'a stock exchange trading floor with glowing screens',
		'a wall of financial ticker displays in the dark',
		'an abstract candlestick chart glowing on a black screen',
		'a downtown financial district at blue hour',
	],
};
const DEFAULT_SECTOR = 'markets';
const COMPOSITION = [
	'wide establishing shot',
	'cinematic close-up detail',
	'dramatic low-angle view',
	'moody overhead view',
];

const MOOD = {
	up: 'subtle emerald green accent lighting, optimistic',
	down: 'subtle deep red accent lighting, tense',
	neutral: 'cool blue accent lighting, neutral',
};

// Build an abstract, safe prompt from a beat's sector + sentiment. `variant`
// (usually the segment index) rotates the scene + camera so each beat differs.
export function buildImagePrompt({sector, sentiment, variant = 0} = {}) {
	const scenes = SECTOR_SCENE[sector] || SECTOR_SCENE[DEFAULT_SECTOR];
	const scene = scenes[variant % scenes.length];
	const comp = COMPOSITION[variant % COMPOSITION.length];
	const mood = MOOD[sentiment] || MOOD.neutral;
	return (
		`Dark moody cinematic ${comp} of ${scene}, deep navy and teal colour grade, ` +
		`${mood}, shallow depth of field, atmospheric, high detail, ` +
		`no text, no words, no logos, no visible faces, vertical composition`
	);
}

// Deterministic seed so re-runs of the same day reproduce the same image.
function seedFrom(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return Math.abs(h) % 1_000_000;
}

async function fetchImage(prompt, seed) {
	const url =
		`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
		`?width=1080&height=1920&nologo=true&model=${MODEL}&seed=${seed}`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {signal: ctrl.signal});
		if (!res.ok) throw new Error(`status ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length < 2000) throw new Error(`suspiciously small (${buf.length}b)`);
		return buf;
	} finally {
		clearTimeout(timer);
	}
}

// Generate (or reuse cached) one image. Returns {absPath, fileName} or null.
export async function generateBeatImage({
	sector,
	sentiment,
	variant = 0,
	cacheKey,
	outDir,
}) {
	const fileName = `${cacheKey}.jpg`;
	const absPath = path.join(outDir, fileName);
	if (fs.existsSync(absPath) && fs.statSync(absPath).size > 2000) {
		return {absPath, fileName, cached: true};
	}
	const prompt = buildImagePrompt({sector, sentiment, variant});
	const seed = seedFrom(cacheKey + prompt);
	fs.mkdirSync(outDir, {recursive: true});
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const buf = await fetchImage(prompt, seed);
			fs.writeFileSync(absPath, buf);
			return {absPath, fileName, cached: false};
		} catch (err) {
			console.warn(`[images] ${cacheKey} attempt ${attempt} failed: ${err.message}`);
			if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
		}
	}
	return null; // caller falls back to gradient
}

// CLI smoke test: `node server/stock/images.mjs`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const outDir = path.join(process.cwd(), 'output', 'stock', '_img-test');
	const cases = [
		{sector: 'healthcare', sentiment: 'up', keywords: ['moderna', 'pharma'], cacheKey: 'health-up'},
		{sector: 'tech', sentiment: 'down', keywords: ['arm', 'semiconductor'], cacheKey: 'tech-down'},
		{sector: undefined, sentiment: 'neutral', keywords: [], cacheKey: 'generic'},
	];
	for (const c of cases) {
		const r = await generateBeatImage({...c, outDir});
		console.log(c.cacheKey, '->', r ? `${r.fileName} (${r.cached ? 'cached' : 'new'})` : 'FAILED (gradient fallback)');
	}
	console.log('Images in', outDir);
}
