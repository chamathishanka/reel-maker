// Orchestrator: fetch -> script -> render -> deliver for one day. This is the
// single entry point the Generate button (and later a cron job) calls.

import path from 'path';
import {pathToFileURL} from 'url';
import {fetchDailyData, todayStr} from './fetch.mjs';
import {generateDaySet} from './script.mjs';
import {renderDay} from './renderStock.mjs';
import {deliverDay} from './deliver.mjs';
import {ROOT} from './env.mjs';
import fs from 'fs';

const PROJECTS_DIR = path.join(ROOT, 'projects', 'stock');

export async function runPipeline({date = todayStr(), onProgress, forceRefetch = false} = {}) {
	const step = (stage, extra = {}) => onProgress?.({stage, ...extra});

	step('fetching');
	const data = await fetchDailyData({date, useCache: !forceRefetch});

	step('scripting');
	const scripts = await generateDaySet(data);
	const dayDir = path.join(PROJECTS_DIR, date);
	fs.mkdirSync(dayDir, {recursive: true});
	fs.writeFileSync(
		path.join(dayDir, 'scripts.json'),
		JSON.stringify({date, generatedAt: new Date().toISOString(), scripts}, null, 2),
	);

	const {outDir, results} = await renderDay({date, onProgress});

	step('delivering');
	const {indexPath} = await deliverDay({date});

	step('done', {reelCount: results.length, outDir, indexPath});
	return {date, outDir, indexPath, reels: results.map((r) => ({type: r.type, title: r.title, file: r.outputFileName}))};
}

// CLI: `node server/stock/pipeline.mjs [YYYY-MM-DD]`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
