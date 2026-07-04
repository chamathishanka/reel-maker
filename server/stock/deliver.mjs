// Stage 5 — DELIVER. Writes output/stock/<date>/index.md: a per-reel brief with
// title, caption, hashtags, tickers, and the posting checklist (incl. the
// AI-content disclosure reminder). Telegram handoff is deferred for now.

import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';
import {ROOT} from './env.mjs';
import {todayStr} from './fetch.mjs';

const PROJECTS_DIR = path.join(ROOT, 'projects', 'stock');
const OUTPUT_DIR = path.join(ROOT, 'output', 'stock');

const TYPE_LABEL = {
	'top-mover': 'Top Mover',
	'market-recap': 'Market Recap',
	headline: 'Headline',
};

export function buildIndexMarkdown(date, reels) {
	const lines = [];
	lines.push(`# US Stock Reels — ${date}`);
	lines.push('');
	lines.push(`${reels.length} reel${reels.length === 1 ? '' : 's'} ready to post. Vertical 1080×1920, ~30–60s each.`);
	lines.push('');
	lines.push('> ⚠️ **When posting: toggle the "AI-generated / altered content" disclosure.** Backgrounds are AI-generated. Disclosure does not reduce reach or monetization — failing to disclose does.');
	lines.push('> ℹ️ Factual recap only — not financial advice. Post original narration; vary your caption slightly if reposting across platforms.');
	lines.push('');
	lines.push('---');

	reels.forEach((r, i) => {
		const num = String(i + 1).padStart(2, '0');
		lines.push('');
		lines.push(`## ${num} · ${TYPE_LABEL[r.type] || r.type} — ${r.title}`);
		lines.push('');
		lines.push(`- **File:** \`${r.file}\``);
		lines.push(`- **Tickers:** ${r.tickers?.length ? r.tickers.join(', ') : '—'}`);
		lines.push(`- **Hook:** ${r.hook || '—'}`);
		lines.push('');
		lines.push('**Caption:**');
		lines.push('');
		lines.push('```');
		lines.push(`${r.fbCaption || ''}`.trim());
		lines.push('');
		lines.push((r.hashtags || []).join(' '));
		lines.push('```');
		lines.push('');
		lines.push('<details><summary>Beats (spoken)</summary>');
		lines.push('');
		(r.segments || [])
			.filter((s) => s.kind === 'beat' || s.kind === 'hook')
			.forEach((s) => lines.push(`- ${s.vo || s.text || ''}`));
		lines.push('');
		lines.push('</details>');
		lines.push('');
		lines.push('---');
	});

	return lines.join('\n');
}

export async function deliverDay({date = todayStr()} = {}) {
	const resolvedPath = path.join(PROJECTS_DIR, date, 'reels.resolved.json');
	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`No reels.resolved.json for ${date}. Run renderStock first.`);
	}
	const {results} = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
	const md = buildIndexMarkdown(date, results);

	const outDir = path.join(OUTPUT_DIR, date);
	fs.mkdirSync(outDir, {recursive: true});
	const indexPath = path.join(outDir, 'index.md');
	fs.writeFileSync(indexPath, md);
	return {indexPath, reelCount: results.length};
}

// CLI: `node server/stock/deliver.mjs [YYYY-MM-DD]`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const date = process.argv[2] || todayStr();
	deliverDay({date})
		.then((r) => console.log(`Wrote ${r.indexPath} (${r.reelCount} reels).`))
		.catch((err) => {
			console.error(`\n[deliver] ${err.message}\n`);
			process.exit(1);
		});
}
