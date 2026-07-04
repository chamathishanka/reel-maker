// Stage 2 — SCRIPT. Turns the fetched market data into narration scripts, one
// per reel. Default day set = market-recap + top-mover + headline.
//
// The LLM is given the REAL news headlines/summaries as grounding so it can
// supply the mandatory "why" behind each move without fabricating — see the
// monetization rule in data/stock/prompts/script-system.md.

import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';
import {ROOT} from './env.mjs';
import {generateJson, GEMINI_MODEL} from './llm.mjs';
import {fetchDailyData, todayStr} from './fetch.mjs';

const DATA_DIR = path.join(ROOT, 'data', 'stock');
const PROJECTS_DIR = path.join(ROOT, 'projects', 'stock');

const SYSTEM_PROMPT = fs.readFileSync(
	path.join(DATA_DIR, 'prompts', 'script-system.md'),
	'utf8',
);

export const DEFAULT_DAY_SET = ['market-recap', 'top-mover', 'headline'];

// JSON contract the model must return (Gemini responseSchema).
const SCRIPT_SCHEMA = {
	type: 'object',
	properties: {
		title: {type: 'string'},
		hook: {type: 'string'},
		beats: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					vo: {type: 'string'},
					caption: {type: 'string'},
					ticker: {type: 'string'},
					sentiment: {type: 'string', enum: ['up', 'down', 'neutral']},
					keywords: {type: 'array', items: {type: 'string'}},
				},
				required: ['vo', 'caption', 'sentiment', 'keywords'],
			},
		},
		cta: {type: 'string'},
		disclaimer: {type: 'string'},
		fbCaption: {type: 'string'},
		hashtags: {type: 'array', items: {type: 'string'}},
	},
	required: ['title', 'hook', 'beats', 'cta', 'fbCaption', 'hashtags'],
};

const fmtPct = (p) =>
	typeof p === 'number' ? `${p >= 0 ? '+' : ''}${p.toFixed(2)}%` : 'n/a';

const moverLine = (q) =>
	`${q.name} (${q.ticker}): ${fmtPct(q.changePct)}, now $${q.price}`;

function newsBlock(items, max = 5) {
	if (!items?.length) return '(no headlines available)';
	return items
		.slice(0, max)
		.map((n) => `- ${n.headline}${n.summary ? ` — ${n.summary.slice(0, 220)}` : ''}`)
		.join('\n');
}

// Per-mover news, formatted for the prompt so each beat has grounding.
function moverNewsBlock(quotes, moverNews) {
	if (!moverNews) return '';
	const blocks = quotes
		.map((q) => {
			const items = moverNews[q.ticker];
			if (!items?.length) return null;
			return `${q.name} (${q.ticker}):\n${newsBlock(items, 2)}`;
		})
		.filter(Boolean);
	return blocks.length
		? `\nPer-stock news (use these as the factual "why"):\n${blocks.join('\n\n')}\n`
		: '';
}

// Build the per-type user prompt from real data.
function buildUserPrompt(type, data) {
	const {movers, marketNews, topMoverNews, moverNews} = data;
	const common =
		`Date: ${data.date}. Use only the facts below; do not invent numbers, tickers, or reasons. ` +
		`If a stock has no per-stock news, attribute its move to the relevant sector or the broader market — ` +
		`do NOT say "no catalyst" or "no reason reported" (that reads as low-effort).\n`;

	if (type === 'market-recap') {
		return (
			common +
			`\nMake a MARKET RECAP reel: a fast tour of the day's notable moves.\n\n` +
			`Top gainers:\n${movers.gainers.map(moverLine).join('\n')}\n\n` +
			`Top losers:\n${movers.losers.map(moverLine).join('\n')}\n` +
			moverNewsBlock([...movers.gainers, ...movers.losers], moverNews) +
			`\nMarket headlines (macro context):\n${newsBlock(marketNews)}\n\n` +
			`Pick 3–4 of the most story-worthy moves for the beats. Open on the single biggest move.`
		);
	}

	if (type === 'top-mover') {
		const tm = movers.topMover;
		return (
			common +
			`\nMake a SINGLE-STOCK STORY reel about the day's biggest mover.\n\n` +
			`Stock: ${tm ? moverLine(tm) : 'n/a'}\n\n` +
			`Company news for this stock (use for the "why"):\n${newsBlock(topMoverNews)}\n\n` +
			`Broader market headlines for context:\n${newsBlock(marketNews, 3)}\n\n` +
			`3 beats: the move, the reason, and one line of factual context. Hook on the number.`
		);
	}

	if (type === 'headline') {
		const relatedMoves = [...movers.gainers, ...movers.losers].slice(0, 6);
		return (
			common +
			`\nMake a MARKET HEADLINE reel built around the day's most significant news.\n\n` +
			`Headlines:\n${newsBlock(marketNews, 6)}\n\n` +
			`Related notable moves you may reference:\n${relatedMoves.map(moverLine).join('\n')}\n` +
			moverNewsBlock(relatedMoves, moverNews) +
			`\nPick the single most market-relevant headline. Explain what happened and, factually, which stocks/sectors it touched.`
		);
	}

	throw new Error(`Unknown reel type "${type}".`);
}

function normalizeScript(script, type) {
	return {
		type,
		title: script.title || type,
		hook: script.hook || '',
		beats: (script.beats || []).slice(0, 5).map((b) => ({
			vo: b.vo || '',
			caption: b.caption || '',
			ticker: b.ticker || '',
			sentiment: ['up', 'down', 'neutral'].includes(b.sentiment)
				? b.sentiment
				: 'neutral',
			keywords: Array.isArray(b.keywords) ? b.keywords : [],
		})),
		cta: script.cta || 'Which of these are you watching?',
		// Enforce the disclaimer regardless of what the model returned.
		disclaimer: 'For information only — not financial advice.',
		fbCaption: script.fbCaption || '',
		hashtags: (Array.isArray(script.hashtags) ? script.hashtags : [])
			.map((t) => t.trim().replace(/^#*/, ''))
			.filter(Boolean)
			.map((t) => `#${t}`),
	};
}

export async function generateScript(type, data) {
	const user = buildUserPrompt(type, data);
	const raw = await generateJson(SYSTEM_PROMPT, user, SCRIPT_SCHEMA);
	return normalizeScript(raw, type);
}

export async function generateDaySet(data, types = DEFAULT_DAY_SET) {
	const scripts = [];
	for (const type of types) {
		scripts.push(await generateScript(type, data));
	}
	return scripts;
}

// Generate scripts for a date, using cached fetch data (fetches if missing).
export async function generateAndSave({date = todayStr(), types} = {}) {
	const data = await fetchDailyData({date, useCache: true});
	const scripts = await generateDaySet(data, types);
	const dayDir = path.join(PROJECTS_DIR, date);
	fs.mkdirSync(dayDir, {recursive: true});
	const out = {date, model: GEMINI_MODEL, generatedAt: new Date().toISOString(), scripts};
	fs.writeFileSync(path.join(dayDir, 'scripts.json'), JSON.stringify(out, null, 2));
	return out;
}

// CLI: `node server/stock/script.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	generateAndSave()
		.then((out) => {
			console.log(`\nModel: ${out.model} | scripts: ${out.scripts.length}\n`);
			for (const s of out.scripts) {
				console.log(`\n=== [${s.type}] ${s.title} ===`);
				console.log(`HOOK: ${s.hook}`);
				s.beats.forEach((b, i) =>
					console.log(`  ${i + 1}. (${b.ticker || '—'}/${b.sentiment}) VO: ${b.vo}\n     CAPTION: ${b.caption} | kw: ${b.keywords.join(', ')}`),
				);
				console.log(`CTA: ${s.cta}`);
				console.log(`FB: ${s.fbCaption}`);
				console.log(`TAGS: ${s.hashtags.join(' ')}`);
			}
			console.log(`\nSaved to projects/stock/${out.date}/scripts.json`);
		})
		.catch((err) => {
			console.error(`\n[script] ${err.message}\n`);
			process.exit(1);
		});
}
