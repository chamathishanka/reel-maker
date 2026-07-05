import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import {fileURLToPath} from 'url';
import {execFile} from 'child_process';
import {promisify} from 'util';
import {renderProject} from './render.mjs';
import {runPipeline} from './stock/pipeline.mjs';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const OUTPUT_DIR = path.join(ROOT, 'output');

// in-memory render job status, keyed by project slug — good enough for a
// single-user local tool (no database needed)
const jobs = {};

async function getAudioDurationSeconds(absPath) {
	const {stdout} = await execFileP('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'format=duration',
		'-of',
		'default=noprint_wrappers=1:nokey=1',
		absPath,
	]);
	return parseFloat(stdout.trim());
}

async function generateWaveformPng(absAudioPath, absPngPath) {
	await execFileP('ffmpeg', [
		'-y',
		'-i',
		absAudioPath,
		'-filter_complex',
		'showwavespic=s=1600x160:colors=#c9a24b',
		'-frames:v',
		'1',
		absPngPath,
	]);
}

fs.mkdirSync(PROJECTS_DIR, {recursive: true});
fs.mkdirSync(OUTPUT_DIR, {recursive: true});

const app = express();
app.use(cors());
app.use(express.json({limit: '10mb'}));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(OUTPUT_DIR));
app.use('/projects-raw', express.static(PROJECTS_DIR));

const slugify = (s) =>
	s
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '') || 'project';

function projectPaths(slug) {
	const dir = path.join(PROJECTS_DIR, slug);
	return {
		dir,
		images: path.join(dir, 'images'),
		audio: path.join(dir, 'audio'),
		slidesJson: path.join(dir, 'slides.json'),
	};
}

// --- list / create projects --------------------------------------------------
app.get('/api/projects', (req, res) => {
	const list = fs.existsSync(PROJECTS_DIR)
		? fs.readdirSync(PROJECTS_DIR).filter((f) => fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory())
		: [];
	res.json({projects: list});
});

app.post('/api/projects', (req, res) => {
	const {title} = req.body;
	if (!title) return res.status(400).json({error: 'title is required'});
	const slug = slugify(title);
	const p = projectPaths(slug);
	fs.mkdirSync(p.images, {recursive: true});
	fs.mkdirSync(p.audio, {recursive: true});
	if (!fs.existsSync(p.slidesJson)) {
		fs.writeFileSync(
			p.slidesJson,
			JSON.stringify(
				{
					projectTitle: title,
					channelName: 'Remember Australia',
					fps: 30,
					width: 1080,
					height: 1920,
					autoFitAudio: true,
					narrationAudio: '',
					musicAudio: '',
					musicVolume: 0.12,
					outroDuration: 2.2,
					engagementPrompt: '',
					slides: [],
				},
				null,
				2
			)
		);
	}
	res.json({slug});
});

app.get('/api/projects/:slug', (req, res) => {
	const p = projectPaths(req.params.slug);
	if (!fs.existsSync(p.slidesJson)) return res.status(404).json({error: 'not found'});
	const data = JSON.parse(fs.readFileSync(p.slidesJson, 'utf-8'));
	const images = fs.existsSync(p.images) ? fs.readdirSync(p.images) : [];
	const audio = fs.existsSync(p.audio) ? fs.readdirSync(p.audio) : [];
	res.json({data, images, audio});
});

// --- uploads ------------------------------------------------------------------
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		const p = projectPaths(req.params.slug);
		const kind = req.query.kind === 'audio' ? p.audio : p.images;
		fs.mkdirSync(kind, {recursive: true});
		cb(null, kind);
	},
	filename: (req, file, cb) => {
		cb(null, file.originalname);
	},
});
const upload = multer({storage});

app.post('/api/projects/:slug/upload', upload.array('files'), async (req, res) => {
	const uploaded = req.files.map((f) => f.filename);
	const response = {uploaded};

	// For audio uploads, report duration back so the frontend can build the
	// duration timeline. For the narration track specifically, also render a
	// waveform image for the timeline preview.
	if (req.query.kind === 'audio' && req.files.length) {
		const p = projectPaths(req.params.slug);
		const file = req.files[0];
		const absPath = path.join(p.audio, file.filename);
		try {
			response.duration = await getAudioDurationSeconds(absPath);
		} catch (err) {
			console.error('ffprobe failed', err);
		}
		if (req.query.role === 'narration') {
			try {
				const pngName = `${path.parse(file.filename).name}.waveform.png`;
				await generateWaveformPng(absPath, path.join(p.audio, pngName));
				response.waveformUrl = `/projects-raw/${req.params.slug}/audio/${pngName}`;
			} catch (err) {
				console.error('waveform generation failed', err);
			}
		}
	}

	res.json(response);
});

// --- save slide data (order, captions, years, ken burns, engagement prompt) ---
app.put('/api/projects/:slug/slides', (req, res) => {
	const p = projectPaths(req.params.slug);
	fs.writeFileSync(p.slidesJson, JSON.stringify(req.body, null, 2));
	res.json({ok: true});
});

// --- generate video -------------------------------------------------------------
// Fire-and-forget: kick off the render, return immediately, and let the
// frontend poll /generate/status for a progress bar.
const STAGE_WEIGHTS = {bundling: 0.05, 'selecting-composition': 0.1, rendering: 1};

app.post('/api/projects/:slug/generate', (req, res) => {
	const {slug} = req.params;

	if (jobs[slug] && !jobs[slug].done && !jobs[slug].error) {
		return res.status(409).json({error: 'A render is already running for this project.'});
	}

	jobs[slug] = {stage: 'starting', progress: 0, done: false, error: null, outputUrl: null};

	renderProject(slug, {
		onProgress: (p) => {
			const base = p.stage === 'rendering' ? STAGE_WEIGHTS.bundling + STAGE_WEIGHTS['selecting-composition'] : 0;
			const stageProgress =
				p.stage === 'rendering'
					? base + (p.progress ?? 0) * (1 - base)
					: p.stage === 'selecting-composition'
					? STAGE_WEIGHTS.bundling
					: 0;
			jobs[slug] = {...jobs[slug], stage: p.stage, progress: Math.min(0.99, stageProgress)};
		},
	})
		.then((result) => {
			jobs[slug] = {
				stage: 'done',
				progress: 1,
				done: true,
				error: null,
				outputUrl: `/output/${result.outputFileName}`,
			};
		})
		.catch((err) => {
			console.error(err);
			jobs[slug] = {stage: 'error', progress: 0, done: true, error: String(err.message || err), outputUrl: null};
		});

	res.json({started: true});
});

app.get('/api/projects/:slug/generate/status', (req, res) => {
	res.json(jobs[req.params.slug] || {stage: 'idle', progress: 0, done: false, error: null, outputUrl: null});
});

// --- US Stock News workflow ----------------------------------------------------
// One fire-and-forget job at a time (single-user local tool). Progress maps the
// pipeline stages (fetch → script → voice → render → deliver) onto 0–1.
const stockJobs = {};
const todayStr = () => new Date().toISOString().slice(0, 10);

function stockProgress(p) {
	switch (p.stage) {
		case 'fetching':
			return 0.05;
		case 'scripting':
			return 0.15;
		case 'voicing':
			return 0.2 + (p.of ? ((p.reel - 1) / p.of) * 0.15 : 0);
		case 'bundling':
			return 0.4;
		case 'selecting-composition':
			return 0.45;
		case 'rendering':
			return 0.45 + (p.of ? ((p.reel - 1 + (p.progress ?? 0)) / p.of) * 0.5 : 0);
		case 'delivering':
			return 0.97;
		default:
			return 0;
	}
}

app.post('/api/stock/generate', (req, res) => {
	const date = (req.body && req.body.date) || todayStr();
	if (stockJobs[date] && !stockJobs[date].done && !stockJobs[date].error) {
		return res.status(409).json({error: 'A stock render is already running for this day.'});
	}
	stockJobs[date] = {stage: 'starting', progress: 0, done: false, error: null, date, reels: null};

	runPipeline({
		date,
		onProgress: (p) => {
			stockJobs[date] = {
				...stockJobs[date],
				stage: p.stage,
				progress: Math.min(0.99, Math.max(stockJobs[date].progress, stockProgress(p))),
			};
		},
	})
		.then(() => {
			// Attach the resolved reels (captions/hashtags/tickers) for the UI.
			let reels = [];
			try {
				const resolved = path.join(PROJECTS_DIR, 'stock', date, 'reels.resolved.json');
				if (fs.existsSync(resolved)) reels = JSON.parse(fs.readFileSync(resolved, 'utf8')).results;
			} catch {
				/* ignore */
			}
			stockJobs[date] = {
				stage: 'done',
				progress: 1,
				done: true,
				error: null,
				date,
				reels,
				indexUrl: `/output/stock/${date}/index.md`,
			};
		})
		.catch((err) => {
			console.error(err);
			stockJobs[date] = {stage: 'error', progress: 0, done: true, error: String(err.message || err), date, reels: null};
		});

	res.json({started: true, date});
});

app.get('/api/stock/status', (req, res) => {
	const date = req.query.date || todayStr();
	res.json(stockJobs[date] || {stage: 'idle', progress: 0, done: false, error: null, date, reels: null});
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => {
	console.log(`Aussie Nostalgia pipeline running at http://localhost:${PORT}`);
});
