// Orchestrator: fetch -> script -> render -> deliver for one day. This is the
// single entry point the Generate button (and later a cron job) calls.

import path from 'path';
import {pathToFileURL} from 'url';
import {fetchDailyData, fetchWeeklyData, isMarketWeekend} from './fetch.mjs';
import {generateDaySet} from './script.mjs';
import {renderDay} from './renderStock.mjs';
import {deliverDay} from './deliver.mjs';
import {scheduleDay} from './publish.mjs';
import {attachFileLogger} from './logger.mjs';
import {checkQuoteFreshness, etDateStr, isNyseHoliday} from './market.mjs';
import {ROOT} from './env.mjs';
import fs from 'fs';

const PROJECTS_DIR = path.join(ROOT, 'projects', 'stock');
const OUTPUT_DIR = path.join(ROOT, 'output', 'stock');

export async function runPipeline({
	date = etDateStr(),
	onProgress,
	forceRefetch = false,
	publish = false,
	dryRunPublish = false,
} = {}) {
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

		// NYSE holidays have no session to report on. Bail before burning API
		// quota — the unattended runner simply produces nothing that day.
		if (!weekly && isNyseHoliday(date)) {
			step('skipped', {reason: 'nyse-holiday', date});
			return {date, skipped: 'nyse-holiday'};
		}

		step('fetching', {mode: weekly ? 'weekly' : 'daily'});
		const data = weekly
			? await fetchWeeklyData({date, useCache: !forceRefetch})
			: await fetchDailyData({date, useCache: !forceRefetch});

		// Backstop for an out-of-date holiday list: if the freshest quote isn't
		// from today's ET session, we'd be narrating stale prices as "today".
		if (!weekly) {
			const freshness = checkQuoteFreshness(data.quotes, date);
			if (freshness.stale) {
				step('skipped', {reason: 'stale-quotes', quoteDate: freshness.quoteDate, date});
				return {date, skipped: 'stale-quotes', quoteDate: freshness.quoteDate};
			}
			if (!freshness.checked) {
				console.warn('[pipeline] quotes carry no timestamp — skipping freshness check');
			}
		}

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

		// Schedule each reel into its type's ET slot. Done last so a publish
		// failure never destroys an otherwise-good render — the mp4s are on disk
		// and `publish.mjs --slots <date>` can retry without re-rendering.
		let scheduled;
		if (publish) {
			step('scheduling', {dryRun: dryRunPublish});
			const res = await scheduleDay({
				date,
				tradingDate: date,
				weekly,
				dryRun: dryRunPublish,
				onProgress: (p) => onProgress?.(p),
			});
			scheduled = res.scheduled;
		}

		step('done', {reelCount: results.length, outDir, indexPath, scheduled: scheduled?.length ?? 0});
		return {
			date,
			outDir,
			indexPath,
			scheduled,
			reels: results.map((r) => ({type: r.type, title: r.title, file: r.outputFileName})),
		};
	} finally {
		detach();
	}
}

// CLI:
//   node server/stock/pipeline.mjs [YYYY-MM-DD]                render only
//   node server/stock/pipeline.mjs [YYYY-MM-DD] --publish      render + schedule to FB
//   node server/stock/pipeline.mjs [YYYY-MM-DD] --publish --dry-run
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const argv = process.argv.slice(2);
	const date = argv.find((a) => !a.startsWith('--')) || etDateStr();
	const publish = argv.includes('--publish');
	const dryRunPublish = argv.includes('--dry-run');

	runPipeline({date, publish, dryRunPublish, onProgress: (p) => console.log(JSON.stringify(p))})
		.then((r) => {
			if (r.skipped) {
				console.log(`\nSkipped ${r.date}: ${r.skipped}`);
				return;
			}
			console.log(`\nDone — ${r.reels.length} reel(s) in ${r.outDir}`);
			r.reels.forEach((x) => console.log(`  ${x.file} (${x.type})`));
			console.log(`Index: ${r.indexPath}`);
			if (r.scheduled?.length) {
				console.log(`Scheduled ${r.scheduled.length} reel(s) to Facebook.`);
			}
		})
		.catch((err) => {
			console.error(`\n[pipeline] ${err.stack || err.message}\n`);
			process.exit(1);
		});
}
