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

// CLI: `node server/stock/publish.mjs [YYYY-MM-DD] [reelIndex] [scheduleAtISO]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const date = process.argv[2] || todayStr();
	const only = process.argv[3] ? Number(process.argv[3]) : undefined;
	const scheduleAt = process.argv[4];
	publishDay({date, only, scheduleAt, onProgress: (p) => console.log(JSON.stringify(p))})
		.then((r) => {
			console.log(`\nPublished ${r.published.length} reel(s) for ${r.date}:`);
			for (const p of r.published) {
				const when = p.scheduledPublishTime
					? `scheduled for ${new Date(p.scheduledPublishTime * 1000).toISOString()}`
					: 'published now';
				console.log(`  ${p.file} -> video_id ${p.videoId} (${when})`);
			}
		})
		.catch((err) => {
			console.error(err.message);
			process.exit(1);
		});
}
