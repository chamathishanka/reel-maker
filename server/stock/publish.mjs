// Publishes rendered reels to the Facebook Page as native Reels, using the
// Graph API's resumable "video_reels" upload flow (start -> upload -> finish).
//
// CLI:
//   node server/stock/publish.mjs [YYYY-MM-DD]                          publish every reel for that day, now
//   node server/stock/publish.mjs [YYYY-MM-DD] 2                        publish just reel #2, now
//   node server/stock/publish.mjs [YYYY-MM-DD] 2 2026-07-11T01:30:00+05:30   schedule reel #2 for that ISO time
//
// Reads projects/stock/<date>/reels.resolved.json (written by renderStock.mjs)
// for the video file path + caption/hashtags, so render must run first.
//
// Meta requires scheduled_publish_time to be 10 minutes to 29 days from now.

import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import {requireEnv, ROOT} from './env.mjs';
import {slotForReel} from './market.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(ROOT, 'projects', 'stock');
const OUTPUT_DIR = path.join(ROOT, 'output', 'stock');
const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const todayStr = () => new Date().toISOString().slice(0, 10);

async function graphCall(url, {method = 'GET', body, headers} = {}) {
	const res = await fetch(url, {method, body, headers});
	const json = await res.json().catch(() => null);
	if (!res.ok || json?.error) {
		const msg = json?.error?.message || `HTTP ${res.status}`;
		throw new Error(`Graph API error: ${msg}`);
	}
	return json;
}

// Combine the fbCaption + hashtags into the single description string Reels
// publishing takes.
function buildDescription({fbCaption, hashtags}) {
	const tags = (hashtags || []).join(' ');
	return [fbCaption, tags].filter(Boolean).join('\n\n');
}

const MIN_LEAD_MS = 10 * 60 * 1000;
const MAX_LEAD_MS = 29 * 24 * 60 * 60 * 1000;

// Validates and converts a schedule time (ISO string or Date) to the Unix
// seconds timestamp the Graph API wants, throwing if outside Meta's allowed
// scheduling window (10 min - 29 days from now).
function toScheduledTimestamp(scheduleAt) {
	const target = scheduleAt instanceof Date ? scheduleAt : new Date(scheduleAt);
	if (Number.isNaN(target.getTime())) {
		throw new TypeError(`Invalid schedule time: ${scheduleAt}`);
	}
	const leadMs = target.getTime() - Date.now();
	if (leadMs < MIN_LEAD_MS) {
		throw new Error(
			`Schedule time ${target.toISOString()} is less than 10 minutes from now — Meta will reject it.`,
		);
	}
	if (leadMs > MAX_LEAD_MS) {
		throw new Error(
			`Schedule time ${target.toISOString()} is more than 29 days from now — Meta will reject it.`,
		);
	}
	return Math.floor(target.getTime() / 1000);
}

async function publishReel({pageId, pageToken, filePath, description, scheduledPublishTime}) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Video file not found: ${filePath}`);
	}
	const fileSize = fs.statSync(filePath).size;

	// 1. Start an upload session.
	const start = await graphCall(
		`${GRAPH_BASE}/${pageId}/video_reels?upload_phase=start&access_token=${encodeURIComponent(pageToken)}`,
		{method: 'POST'},
	);
	const videoId = start.video_id;
	const uploadUrl = start.upload_url;
	if (!videoId || !uploadUrl) {
		throw new Error(`Unexpected start response: ${JSON.stringify(start)}`);
	}

	// 2. Upload the raw video bytes to the returned upload_url.
	const fileBuffer = fs.readFileSync(filePath);
	const uploadRes = await fetch(uploadUrl, {
		method: 'POST',
		headers: {
			Authorization: `OAuth ${pageToken}`,
			offset: '0',
			file_size: String(fileSize),
		},
		body: fileBuffer,
	});
	const uploadJson = await uploadRes.json().catch(() => null);
	if (!uploadRes.ok || uploadJson?.success === false) {
		throw new Error(`Upload failed: ${JSON.stringify(uploadJson) || uploadRes.status}`);
	}

	// 3. Finish — publish (or schedule) the reel with its caption.
	const finishUrl = new URL(`${GRAPH_BASE}/${pageId}/video_reels`);
	finishUrl.searchParams.set('upload_phase', 'finish');
	finishUrl.searchParams.set('video_id', videoId);
	if (scheduledPublishTime) {
		finishUrl.searchParams.set('video_state', 'SCHEDULED');
		finishUrl.searchParams.set('scheduled_publish_time', String(scheduledPublishTime));
	} else {
		finishUrl.searchParams.set('video_state', 'PUBLISHED');
	}
	finishUrl.searchParams.set('description', description);
	finishUrl.searchParams.set('access_token', pageToken);
	const finish = await graphCall(finishUrl.toString(), {method: 'POST'});

	return {videoId, finish};
}

export async function publishDay({date = todayStr(), only, scheduleAt, onProgress} = {}) {
	const pageId = requireEnv('FB_PAGE_ID');
	const pageToken = requireEnv('FB_PAGE_ACCESS_TOKEN');
	const scheduledPublishTime = scheduleAt ? toScheduledTimestamp(scheduleAt) : undefined;

	const resolvedPath = path.join(PROJECTS_DIR, date, 'reels.resolved.json');
	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`No reels.resolved.json for ${date}. Run renderStock.mjs first.`);
	}
	const {results} = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
	const outDir = path.join(OUTPUT_DIR, date);

	const targets = only ? [results[only - 1]].filter(Boolean) : results;
	if (!targets.length) {
		throw new Error(`No matching reel(s) for ${date}${only ? ` at index ${only}` : ''}.`);
	}

	const published = [];
	for (let i = 0; i < targets.length; i++) {
		const reel = targets[i];
		onProgress?.({stage: 'publishing', reel: i + 1, of: targets.length, type: reel.type});
		const {videoId} = await publishReel({
			pageId,
			pageToken,
			filePath: path.join(outDir, reel.file),
			description: buildDescription(reel),
			scheduledPublishTime,
		});
		published.push({type: reel.type, file: reel.file, videoId, scheduledPublishTime});
		onProgress?.({stage: 'published', reel: i + 1, of: targets.length, type: reel.type, videoId});
	}

	return {date, published};
}

const fmtEt = (d) =>
	new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(d);

// True when the day's cached market data was fetched as a weekly wrap. Lets the
// standalone CLI pick the weekend slot table without being told.
function isWeeklyDay(date) {
	const dataPath = path.join(PROJECTS_DIR, date, 'data.json');
	if (!fs.existsSync(dataPath)) return false;
	try {
		return JSON.parse(fs.readFileSync(dataPath, 'utf8')).mode === 'weekly';
	} catch {
		return false;
	}
}

// Schedule every reel of a day into its type's slot (see market.mjs). This is
// what the unattended run calls: one render, then N future posts.
//
// Weekdays spread 3 reels over ~18h; the Saturday weekly wrap spreads its 2
// reels across Saturday and Sunday.
//
// `dryRun` resolves and prints the slots without uploading anything — always
// worth doing first, since publishing is public and hard to reverse.
export async function scheduleDay({date, tradingDate = date, weekly, dryRun = false, onProgress} = {}) {
	const resolvedPath = path.join(PROJECTS_DIR, date, 'reels.resolved.json');
	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`No reels.resolved.json for ${date}. Run renderStock.mjs first.`);
	}
	const {results} = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
	const outDir = path.join(OUTPUT_DIR, date);
	const isWeekly = weekly ?? isWeeklyDay(date);

	// Resolve every slot up front so a bad one fails before we upload anything.
	//
	// A same-day slot can already be in the past when the run itself was delayed
	// (GitHub Actions cron routinely slips, sometimes by 30+ min). Clamp those to
	// shortly from now rather than rolling to tomorrow: a day-late "top mover"
	// would post beside tomorrow's real one and collide with its slot, whereas a
	// slightly-late one is still the same evening and still current.
	// Clamped reels are staggered so a delayed run doesn't dump all three at once.
	const CLAMP_STAGGER_MS = 45 * 60 * 1000;
	const clampFloor = Date.now() + MIN_LEAD_MS + 2 * 60 * 1000;
	let clampedCount = 0;
	const plan = results.map((reel, i) => {
		const slot = slotForReel(reel.type, tradingDate, i, {weekly: isWeekly});
		let at = slot;
		if (slot.getTime() < clampFloor) {
			at = new Date(clampFloor + clampedCount * CLAMP_STAGGER_MS);
			clampedCount++;
			console.warn(
				`[publish] ${reel.type} slot (${fmtEt(slot)} ET) already passed — clamped to ${fmtEt(at)} ET`,
			);
		}
		return {reel, at, scheduledPublishTime: toScheduledTimestamp(at)};
	});

	if (dryRun) {
		for (const p of plan) {
			console.log(`  [dry-run] ${p.reel.file}  (${p.reel.type})  ->  ${fmtEt(p.at)} ET`);
		}
		return {date, dryRun: true, plan: plan.map((p) => ({file: p.reel.file, type: p.reel.type, at: p.at}))};
	}

	const pageId = requireEnv('FB_PAGE_ID');
	const pageToken = requireEnv('FB_PAGE_ACCESS_TOKEN');

	const scheduled = [];
	for (let i = 0; i < plan.length; i++) {
		const {reel, at, scheduledPublishTime} = plan[i];
		onProgress?.({stage: 'scheduling', reel: i + 1, of: plan.length, type: reel.type, at});
		const {videoId} = await publishReel({
			pageId,
			pageToken,
			filePath: path.join(outDir, reel.file),
			description: buildDescription(reel),
			scheduledPublishTime,
		});
		scheduled.push({type: reel.type, file: reel.file, videoId, at});
		onProgress?.({stage: 'scheduled', reel: i + 1, of: plan.length, type: reel.type, videoId, at});
	}

	return {date, scheduled};
}

// CLI:
//   node server/stock/publish.mjs [YYYY-MM-DD] [reelIndex] [scheduleAtISO]
//   node server/stock/publish.mjs --slots [YYYY-MM-DD] [--dry-run]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const argv = process.argv.slice(2);
	const useSlots = argv.includes('--slots');
	const dryRun = argv.includes('--dry-run');
	const positional = argv.filter((a) => !a.startsWith('--'));

	const run = useSlots
		? scheduleDay({
				date: positional[0] || todayStr(),
				dryRun,
				onProgress: (p) => console.log(JSON.stringify({...p, at: p.at?.toISOString()})),
			}).then((r) => {
				if (r.dryRun) return;
				console.log(`\nScheduled ${r.scheduled.length} reel(s) for ${r.date}:`);
				for (const s of r.scheduled) {
					console.log(`  ${s.file} -> video_id ${s.videoId} (${fmtEt(s.at)} ET)`);
				}
			})
		: publishDay({
				date: positional[0] || todayStr(),
				only: positional[1] ? Number(positional[1]) : undefined,
				scheduleAt: positional[2],
				onProgress: (p) => console.log(JSON.stringify(p)),
			}).then((r) => {
				console.log(`\nPublished ${r.published.length} reel(s) for ${r.date}:`);
				for (const p of r.published) {
					const when = p.scheduledPublishTime
						? `scheduled for ${fmtEt(new Date(p.scheduledPublishTime * 1000))} ET`
						: 'published now';
					console.log(`  ${p.file} -> video_id ${p.videoId} (${when})`);
				}
			});

	run.catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
}
