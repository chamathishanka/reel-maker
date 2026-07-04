import path from 'path';
import fs from 'fs';
import {fileURLToPath} from 'url';
import {execFile} from 'child_process';
import {promisify} from 'util';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';

async function resolveBrowserExecutable() {
	try {
		const mod = await import('@sparticuz/chromium');
		const chromium = mod.default || mod;
		return await chromium.executablePath();
	} catch {
		return undefined;
	}
}

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const OUTPUT_DIR = path.join(ROOT, 'output');

async function getAudioDurationSeconds(absPath) {
	const {stdout} = await execFileP('ffprobe', [
		'-v', 'error', '-show_entries', 'format=duration',
		'-of', 'default=noprint_wrappers=1:nokey=1', absPath,
	]);
	return parseFloat(stdout.trim());
}

function fitSlideDurationsToAudio(slides, targetTotalSeconds) {
	const weights = slides.map((s) => Math.max(1, (s.caption || '').length));
	const weightSum = weights.reduce((a, b) => a + b, 0);
	const minSeconds = 1.6;
	let allocated = weights.map((w) => Math.max(minSeconds, (w / weightSum) * targetTotalSeconds));
	const allocatedSum = allocated.reduce((a, b) => a + b, 0);
	const scale = targetTotalSeconds / allocatedSum;
	return allocated.map((d) => Math.round(d * scale * 100) / 100);
}

function syncProjectAssetsToPublic(slug) {
	const src = path.join(PROJECTS_DIR, slug);
	const dest = path.join(PUBLIC_DIR, 'projects', slug);
	fs.mkdirSync(dest, {recursive: true});
	for (const sub of ['images', 'audio']) {
		const srcSub = path.join(src, sub);
		const destSub = path.join(dest, sub);
		if (fs.existsSync(srcSub)) {
			fs.mkdirSync(destSub, {recursive: true});
			for (const file of fs.readdirSync(srcSub)) {
				fs.copyFileSync(path.join(srcSub, file), path.join(destSub, file));
			}
		}
	}
}

export async function renderProject(slug, {onProgress} = {}) {
	const projectDir = path.join(PROJECTS_DIR, slug);
	const slidesPath = path.join(projectDir, 'slides.json');
	if (!fs.existsSync(slidesPath)) {
		throw new Error(`No slides.json found for project "${slug}" at ${slidesPath}`);
	}
	const data = JSON.parse(fs.readFileSync(slidesPath, 'utf-8'));

	syncProjectAssetsToPublic(slug);

	if (data.autoFitAudio && data.narrationAudio) {
		const narrationAbs = path.join(PUBLIC_DIR, data.narrationAudio);
		if (fs.existsSync(narrationAbs)) {
			const audioSeconds = await getAudioDurationSeconds(narrationAbs);
			const outroSeconds = data.engagementPrompt ? data.outroDuration || 2.2 : 0;
			const targetSlidesSeconds = Math.max(2, audioSeconds - outroSeconds);
			const fitted = fitSlideDurationsToAudio(data.slides, targetSlidesSeconds);
			data.slides = data.slides.map((s, i) => ({...s, duration: fitted[i]}));
		}
	}

	const entry = path.join(ROOT, 'src', 'index.jsx');
	onProgress?.({stage: 'bundling'});
	const bundleLocation = await bundle({
		entryPoint: entry,
		onProgress: () => {},
	});

	const browserExecutable = await resolveBrowserExecutable();

	onProgress?.({stage: 'selecting-composition'});
	const composition = await selectComposition({
		serveUrl: bundleLocation,
		id: 'NostalgiaVideo',
		inputProps: {data},
		browserExecutable,
		chromiumOptions: {ignoreCertificateErrors: true, disableWebSecurity: true},
	});

	const outputFileName = `${slug}-${Date.now()}.mp4`;
	const outputLocation = path.join(OUTPUT_DIR, outputFileName);
	fs.mkdirSync(OUTPUT_DIR, {recursive: true});

	onProgress?.({stage: 'rendering'});
	await renderMedia({
		composition,
		serveUrl: bundleLocation,
		codec: 'h264',
		outputLocation,
		inputProps: {data},
		browserExecutable,
		chromiumOptions: {ignoreCertificateErrors: true, disableWebSecurity: true},
		onProgress: ({progress}) => onProgress?.({stage: 'rendering', progress}),
	});

	fs.writeFileSync(path.join(projectDir, 'slides.resolved.json'), JSON.stringify(data, null, 2));

	return {outputLocation, outputFileName, data};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const slug = process.argv[2];
	if (!slug) {
		console.error('Usage: node server/render.mjs <project-slug>');
		process.exit(1);
	}
	renderProject(slug, {
		onProgress: (p) => console.log(p),
	})
		.then((r) => console.log('Done ->', r.outputLocation))
		.catch((e) => {
			console.error(e);
			process.exit(1);
		});
}
