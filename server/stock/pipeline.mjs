// Orchestrator: fetch -> script -> render -> deliver for one day. This is the
// single entry point the Generate button (and later a cron job) calls.

import path from 'path';
import {pathToFileURL} from 'url';
import {fetchDailyData, fetchWeeklyData, isMarketWeekend, todayStr} from './fetch.mjs';
import {generateDaySet} from './script.mjs';
import {renderDay} from './renderStock.mjs';
import {deliverDay} from './deliver.mjs';
import {attachFileLogger} from './logger.mjs';
import {ROOT} from './env.mjs';
import fs from 'fs';

const PROJECTS_DIR = path.join(ROOT, 'projects', 'stock');
const OUTPUT_DIR = path.join(ROOT, 'output', 'stock');

export async function runPipeline({date = todayStr(), onProgress, forceRefetch = false} = {}) {
	// Everything this run prints also lands in output/stock/<date>/pipeline.log
	const detach = attachFileLogger(path.join(OUTPUT_DIR, date, 'pipeline.log'));
	const started = Date.now();
	const step = (stage, extra = {}) => {
		const secs = ((Date.now() - started) / 1000).toFixed(0);
		console.log(`[pipeline +${secs}s] ${stage}`, Object.keys(extra).length ? extra : '');
		onProgress?.({stage, ...extra});
	};

	try {
		// On US market weekends, produce a weekly wrap instead of a (stale) daily one.
		const weekly = isMarketWeekend(date);

		step('fetching', {mode: weekly ? 'weekly' : 'daily'});
		const data = weekly
			? await fetchWeeklyData({date, useCache: !forceRefetch})
			: await fetchDailyData({date, useCache: !forceRefetch});

		step('scripting');
		const scripts = await generateDaySet(data, {mode: weekly ? 'weekly' : 'daily'});
		const dayDir = path.join(PROJECTS_DIR, date);
		fs.mkdirSync(dayDir, {recursive: true});
		fs.writeFileSync(
			path.join(dayDir, 'scripts.json'),
			JSON.stringify({date, generatedAt: new Date().toISOString(), scripts}, null, 2),
		);

		// Log render sub-steps too (voicing per segment, rendering %), but don't
		// spam the file with every rendering tick.
		const {outDir, results} = await renderDay({
			date,
			onProgress: (p) => {
				if (p.stage !== 'rendering' || (p.progress ?? 0) === 0) {
					const secs = ((Date.now() - started) / 1000).toFixed(0);
					console.log(`[pipeline +${secs}s] ${p.stage}`, p);
				}
				onProgress?.(p);
			},
		});

		step('delivering');
		const {indexPath} = await deliverDay({date});

		step('done', {reelCount: results.length, outDir, indexPath});
		return {date, outDir, indexPath, reels: results.map((r) => ({type: r.type, title: r.title, file: r.outputFileName}))};
	} finally {
		detach();
	}
}

// CLI: `node server/stock/pipeline.mjs [YYYY-MM-DD]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const date = process.argv[2] || todayStr();
	runPipeline({date, onProgress: (p) => console.log(JSON.stringify(p))})
		.then((r) => {
			console.log(`\nDone — ${r.reels.length} reel(s) in ${r.outDir}`);
			r.reels.forEach((x) => console.log(`  ${x.file} (${x.type})`));
			console.log(`Index: ${r.indexPath}`);
		})
		.catch((err) => {
			console.error(`\n[pipeline] ${err.stack || err.message}\n`);
			process.exit(1);
		});
}
