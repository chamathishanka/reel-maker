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

// JSON contract for a single reel (Gemini responseSchema).
const REEL_SCHEMA = {
	type: 'object',
	properties: {
		type: {type: 'string', enum: ['market-recap', 'top-mover', 'headline']},
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
		fbCaption: {type: 'string'},
		hashtags: {type: 'array', items: {type: 'string'}},
	},
	required: ['type', 'title', 'hook', 'beats', 'cta', 'fbCaption', 'hashtags'],
};

// The whole day's set is generated in ONE call so the reels can be made aware
// of each other (distinct leads, distinct focus) and the count can adapt.
const DAYSET_SCHEMA = {
	type: 'object',
	properties: {reels: {type: 'array', items: REEL_SCHEMA}},
	required: ['reels'],
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

// Build ONE prompt describing the period's data plus the lane rules that keep
// the reels distinct. mode 'weekly' frames everything as a week-in-review (US
// markets are closed on weekends) using weekly % moves.
function buildDaySetPrompt(data, mode = 'daily') {
	const {movers, marketNews, moverNews} = data;
	const tm = movers.topMover;
	const allMovers = [...movers.gainers, ...movers.losers];
	const weekly = mode === 'weekly';
	const period = weekly ? 'this week' : 'today';
	const Period = weekly ? 'This week' : 'Today';
	const moves = weekly ? 'moves are WEEKLY (Mon–Fri)' : 'moves are for the latest session';

	return (
		`Date: ${data.date}. ${weekly ? 'WEEKLY WRAP — US markets are closed today; summarize THE WEEK. ' : ''}` +
		`All ${moves}. Use ONLY the facts below; never invent numbers, tickers, or reasons. ` +
		`If a stock has no per-stock news, attribute its move to its sector or the broader market — ` +
		`do NOT say "no catalyst" / "no reason reported" (reads as low-effort). Say "${period}", not the other.\n\n` +
		`${Period}'s biggest mover: ${tm ? moverLine(tm) : 'n/a'}\n\n` +
		`Top gainers:\n${movers.gainers.map(moverLine).join('\n')}\n\n` +
		`Top losers:\n${movers.losers.map(moverLine).join('\n')}\n` +
		moverNewsBlock(allMovers, moverNews) +
		`\nMarket headlines:\n${newsBlock(marketNews, 8)}\n\n` +
		// Weekly must be EXACTLY 2: the Saturday run slots one reel to Saturday and
		// one to Sunday, so a single-reel week would leave Sunday with no video.
		`TASK: produce a SET of ${weekly ? 'EXACTLY 2' : '2 OR 3'} short reels for ${period}. They post ` +
		`together, so they MUST read as clearly different videos — different opening ` +
		`line, different lead stock/topic, different focus. No two reels may lead with ` +
		`the same stock. Assign these lanes:\n` +
		`1. "top-mover" (ALWAYS): a single-stock deep story on ${tm ? tm.name + ' (' + tm.ticker + ')' : 'the biggest mover'}, ` +
		`framed as ${period}'s standout. Only THIS reel may lead with that stock. The hook states the move; ` +
		`then 3 beats that ADVANCE the story WITHOUT restating the hook — (1) the reason/why, (2) supporting ` +
		`context or a related detail, (3) what it means going forward. Never make a beat that just repeats the ` +
		`hook's number.\n` +
		`2. "market-recap" (ALWAYS): a broader ${weekly ? 'week-in-review' : 'tour'}. It must NOT lead with ${tm ? tm.ticker : 'the top mover'}; ` +
		`instead open the HOOK on ONE specific standout — a named stock (not the top mover) and its exact ` +
		`number — then cover 3–4 DIFFERENT names. Do NOT open with a vague "mixed market" / "several stocks moved" line.\n` +
		(weekly
			? ''
			: `3. "headline" (ONLY IF there is genuinely market-moving news today): lead with the ` +
				`news event itself, not a stock price. If today's headlines are NOT clearly ` +
				`market-moving (e.g. a holiday / thin news day), OMIT this reel and return only 2.\n`) +
		`\nReturn {"reels": [...]} with each reel's "type" set to its lane.`
	);
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

// Order reels consistently (top-mover, recap, headline) regardless of the
// order the model returned them in.
const LANE_ORDER = {'top-mover': 0, 'market-recap': 1, headline: 2};

export async function generateDaySet(data, {mode = data.mode || 'daily'} = {}) {
	const user = buildDaySetPrompt(data, mode);
	const raw = await generateJson(SYSTEM_PROMPT, user, DAYSET_SCHEMA);
	let reels = (raw.reels || []).map((r) => normalizeScript(r, r.type));

	// Safety net: drop a reel whose lead stock duplicates an earlier reel's, so
	// the set never ships two near-identical videos even if the model slips.
	const seenLead = new Set();
	reels = reels.filter((r) => {
		const lead = (r.beats.find((b) => b.ticker)?.ticker || r.type).toUpperCase();
		if (seenLead.has(lead)) {
			console.warn(`[script] dropping duplicate-lead reel (${r.type}, lead ${lead}).`);
			return false;
		}
		seenLead.add(lead);
		return true;
	});

	reels.sort((a, b) => (LANE_ORDER[a.type] ?? 9) - (LANE_ORDER[b.type] ?? 9));
	return reels;
}

// Generate scripts for a date, using cached fetch data (fetches if missing).
export async function generateAndSave({date = todayStr()} = {}) {
	const data = await fetchDailyData({date, useCache: true});
	const scripts = await generateDaySet(data);
	const dayDir = path.join(PROJECTS_DIR, date);
	fs.mkdirSync(dayDir, {recursive: true});
	const out = {date, model: GEMINI_MODEL, generatedAt: new Date().toISOString(), scripts};
	fs.writeFileSync(path.join(dayDir, 'scripts.json'), JSON.stringify(out, null, 2));
	return out;
}

// CLI: `node server/stock/script.mjs`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
