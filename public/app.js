const api = (p, opts) => fetch(`/api${p}`, opts).then((r) => r.json());

let currentSlug = null;
let projectData = null; // full slides.json contents
let images = []; // filenames already uploaded on disk
let statusPollTimer = null;

const el = (id) => document.getElementById(id);

const escapeHtml = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const KEN_BURNS_OPTIONS = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right'];

// Accepts friendly spellings from an imported JSON ("Zoom in", "pan_left", …)
// and normalises them to the internal kebab-case value.
function normalizeKenBurns(value) {
	if (!value) return null;
	const v = String(value).toLowerCase().trim().replace(/[\s_]+/g, '-');
	return KEN_BURNS_OPTIONS.includes(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Undo history — snapshots the whole project state (deep JSON clone) *before*
// each mutating action. Ctrl+Z or the Undo button restores the last snapshot.
// ---------------------------------------------------------------------------

let undoStack = [];
const MAX_UNDO = 60;

// Call at the START of any action that changes projectData. Consecutive
// identical snapshots are coalesced so nothing (e.g. focusing a field without
// typing) fills the stack with duplicates.
function pushUndo() {
	if (!projectData) return;
	const snap = JSON.stringify(projectData);
	if (undoStack.length && undoStack[undoStack.length - 1] === snap) return;
	undoStack.push(snap);
	if (undoStack.length > MAX_UNDO) undoStack.shift();
	updateUndoButton();
}

function updateUndoButton() {
	const btn = el('undoBtn');
	if (btn) btn.disabled = undoStack.length === 0;
}

function undo() {
	if (!undoStack.length) return;
	projectData = JSON.parse(undoStack.pop());
	// re-sync the form fields that live outside the card list
	el('engagementPrompt').value = projectData.engagementPrompt || '';
	el('channelName').value = projectData.channelName || 'Remember Australia';
	el('musicVolume').value = projectData.musicVolume ?? 0.12;
	renderCards();
	renderTimeline();
	updateUndoButton();
	el('status').textContent = 'Undid last change.';
}

async function refreshProjectList(selectSlug) {
	const {projects} = await api('/projects');
	const select = el('projectSelect');
	select.innerHTML = '<option value="">-- select a project --</option>';
	for (const slug of projects) {
		const opt = document.createElement('option');
		opt.value = slug;
		opt.textContent = slug;
		select.appendChild(opt);
	}
	if (selectSlug) select.value = selectSlug;
}

async function loadProject(slug) {
	currentSlug = slug;
	const res = await api(`/projects/${slug}`);
	projectData = res.data;
	images = res.images;
	el('app').classList.remove('hidden');
	el('engagementPrompt').value = projectData.engagementPrompt || '';
	el('channelName').value = projectData.channelName || 'Remember Australia';
	el('musicVolume').value = projectData.musicVolume ?? 0.12;
	undoStack = [];
	updateUndoButton();
	renderCards();
	renderTimeline();
	resetProgressUI();
}

// ---------------------------------------------------------------------------
// Slide cards (images + captions), with internal reorder drag, external OS
// file drag-and-drop, and a click-to-set Ken Burns focal point.
// ---------------------------------------------------------------------------

function renderCards() {
	const list = el('slideCards');
	list.innerHTML = '';
	(projectData.slides || []).forEach((slide, i) => {
		const card = document.createElement('div');
		card.className = 'slide-card';
		card.draggable = true;
		card.dataset.index = i;

		const imgSrc = slide.image
			? `/projects-raw/${currentSlug}/images/${slide.image.split('/').pop()}`
			: '';

		card.innerHTML = `
      <div class="thumb" title="Click to set the zoom/pan target point — or drop an image here to replace">${
			imgSrc ? `<img src="${imgSrc}" />` : '<div class="thumb-empty">No image yet</div>'
		}<span class="order">${i + 1}</span><div class="focal-marker"></div><div class="thumb-overlay">Drop image to replace</div></div>
      <div class="fields">
        <textarea placeholder="Caption / narration line for this slide">${escapeHtml(slide.caption || '')}</textarea>
        <input class="year" placeholder="Year / era (e.g. 1950s)" value="${escapeHtml(slide.year || '')}" />
        <select class="kb">
          <option value="zoom-in">Zoom in</option>
          <option value="zoom-out">Zoom out</option>
          <option value="pan-left">Pan left</option>
          <option value="pan-right">Pan right</option>
        </select>
        <div class="card-actions">
          <label class="replace-btn">Replace image<input type="file" class="replace-input" accept="image/*" /></label>
          <button class="remove">Remove</button>
        </div>
      </div>
    `;
		card.querySelector('.kb').value = slide.kenBurns || 'zoom-in';
		const captionField = card.querySelector('textarea');
		captionField.addEventListener('focus', pushUndo);
		captionField.addEventListener('input', (e) => {
			projectData.slides[i].caption = e.target.value;
			updateTimelineCaption(i, e.target.value);
		});
		card.querySelector('.replace-input').addEventListener('change', async (e) => {
			if (e.target.files[0]) await replaceSlideImage(i, e.target.files[0]);
			e.target.value = '';
		});
		const yearField = card.querySelector('.year');
		yearField.addEventListener('focus', pushUndo);
		yearField.addEventListener('input', (e) => {
			projectData.slides[i].year = e.target.value;
		});
		card.querySelector('.kb').addEventListener('change', (e) => {
			pushUndo();
			projectData.slides[i].kenBurns = e.target.value;
		});
		card.querySelector('.remove').addEventListener('click', () => {
			pushUndo();
			projectData.slides.splice(i, 1);
			renderCards();
			renderTimeline();
		});

		const thumb = card.querySelector('.thumb');
		const marker = card.querySelector('.focal-marker');
		const positionMarker = () => {
			marker.style.left = `${slide.focalX ?? 50}%`;
			marker.style.top = `${slide.focalY ?? 50}%`;
		};
		positionMarker();
		thumb.addEventListener('click', (e) => {
			pushUndo();
			const rect = thumb.getBoundingClientRect();
			const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
			const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
			slide.focalX = Math.round(x * 10) / 10;
			slide.focalY = Math.round(y * 10) / 10;
			positionMarker();
		});

		// Drop a single image directly onto this card's thumbnail to replace just
		// this slide's photo (stopPropagation keeps it from bubbling up to the
		// #dropZone handler, which would otherwise append it as a new slide).
		thumb.addEventListener('dragover', (e) => {
			if (!e.dataTransfer.types.includes('Files')) return;
			e.preventDefault();
			e.stopPropagation();
			thumb.classList.add('img-drop');
		});
		thumb.addEventListener('dragleave', () => thumb.classList.remove('img-drop'));
		thumb.addEventListener('drop', async (e) => {
			if (!e.dataTransfer.types.includes('Files')) return;
			e.preventDefault();
			e.stopPropagation();
			thumb.classList.remove('img-drop');
			const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
			if (file) await replaceSlideImage(i, file);
		});

		card.addEventListener('dragstart', () => {
			pushUndo();
			card.classList.add('dragging');
		});
		card.addEventListener('dragend', () => {
			card.classList.remove('dragging');
			commitOrderFromDom();
		});
		card.addEventListener('dragover', (e) => {
			e.preventDefault();
			const dragging = list.querySelector('.dragging');
			if (!dragging || dragging === card) return;
			const rect = card.getBoundingClientRect();
			const after = e.clientX - rect.left > rect.width / 2;
			card.parentNode.insertBefore(dragging, after ? card.nextSibling : card);
		});

		list.appendChild(card);
	});
}

function commitOrderFromDom() {
	const list = el('slideCards');
	const rebuilt = [...list.children].map((card) => projectData.slides[Number(card.dataset.index)]);
	projectData.slides = rebuilt;
	renderCards();
	renderTimeline();
}

async function uploadImageFiles(files) {
	if (!currentSlug) return alert('Create or select a project first.');
	const imageFiles = files.filter((f) => f.type.startsWith('image/'));
	if (!imageFiles.length) return;
	const form = new FormData();
	imageFiles.forEach((f) => form.append('files', f));
	const {uploaded} = await api(`/projects/${currentSlug}/upload?kind=images`, {
		method: 'POST',
		body: form,
	});
	pushUndo();
	uploaded.forEach((filename) => {
		projectData.slides.push({
			image: `projects/${currentSlug}/images/${filename}`,
			caption: '',
			year: '',
			kenBurns: 'zoom-in',
			duration: 4,
			focalX: 50,
			focalY: 50,
		});
	});
	renderCards();
	renderTimeline();
}

// Replace a single slide's image (from its Replace button or a drop on the card)
async function replaceSlideImage(index, file) {
	if (!currentSlug) return alert('Create or select a project first.');
	if (!file || !file.type.startsWith('image/')) return;
	const form = new FormData();
	form.append('files', file);
	const {uploaded} = await api(`/projects/${currentSlug}/upload?kind=images`, {method: 'POST', body: form});
	if (uploaded && uploaded[0]) {
		pushUndo();
		projectData.slides[index].image = `projects/${currentSlug}/images/${uploaded[0]}`;
		renderCards();
		renderTimeline();
	}
}

el('imageInput').addEventListener('change', async (e) => {
	await uploadImageFiles([...e.target.files]);
	e.target.value = '';
});

// ---------------------------------------------------------------------------
// Import captions/years/durations/motion for every slide from a JSON file
// ---------------------------------------------------------------------------

function makeBlankSlide() {
	return {image: '', caption: '', year: '', kenBurns: 'zoom-in', duration: 4, focalX: 50, focalY: 50};
}

// Applies a JSON caption list to the slides in order. Existing images/focal
// points are preserved; if the list is longer than the current slides, extra
// (image-less) slides are created so you can import a full script first and
// attach photos to each card afterwards.
function applyCaptionsJson(raw) {
	let entries = raw;
	if (!Array.isArray(entries)) entries = raw.slides || raw.captions || raw.sections;
	if (!Array.isArray(entries)) {
		alert('That JSON should be an array of slides, or an object with a "slides" array.');
		return;
	}
	pushUndo();
	projectData.slides = projectData.slides || [];
	entries.forEach((entry, i) => {
		if (!projectData.slides[i]) projectData.slides[i] = makeBlankSlide();
		const s = projectData.slides[i];
		if (entry.caption != null || entry.text != null) s.caption = String(entry.caption ?? entry.text);
		if (entry.year != null || entry.header != null) s.year = String(entry.year ?? entry.header);
		const dur = Number(entry.duration ?? entry.length ?? entry.seconds);
		if (Number.isFinite(dur) && dur > 0) s.duration = dur;
		const kb = normalizeKenBurns(entry.kenBurns ?? entry.effect ?? entry.motion ?? entry.movement);
		if (kb) s.kenBurns = kb;
	});
	projectData.autoFitAudio = false;
	renderCards();
	renderTimeline();
	el('status').textContent = `Imported ${entries.length} caption${entries.length === 1 ? '' : 's'} from JSON.`;
}

const CAPTIONS_FORMAT_SAMPLE = [
	{caption: 'The first line of narration for this slide.', year: '1950s', duration: 4, kenBurns: 'zoom-in'},
	{caption: 'The next slide, shown a little longer.', year: '1963', duration: 5.5, kenBurns: 'pan-left'},
];

// Toggle the paste box open/closed
el('pasteCaptionsBtn').addEventListener('click', () => {
	if (!currentSlug) return alert('Create or select a project first.');
	const area = el('pasteArea');
	area.classList.toggle('hidden');
	if (!area.classList.contains('hidden')) el('pasteJsonInput').focus();
});

el('cancelPasteBtn').addEventListener('click', () => {
	el('pasteArea').classList.add('hidden');
	el('pasteJsonInput').value = '';
});

el('applyPasteBtn').addEventListener('click', () => {
	const text = el('pasteJsonInput').value.trim();
	if (!text) return;
	try {
		applyCaptionsJson(JSON.parse(text));
		el('pasteArea').classList.add('hidden');
		el('pasteJsonInput').value = '';
	} catch (err) {
		alert(`That isn't valid JSON: ${err.message}`);
	}
});

// Copy the exact expected format (as JSON text) to the clipboard
el('copyFormatBtn').addEventListener('click', async () => {
	const text = JSON.stringify(CAPTIONS_FORMAT_SAMPLE, null, 2);
	try {
		await navigator.clipboard.writeText(text);
		const btn = el('copyFormatBtn');
		const original = btn.textContent;
		btn.textContent = 'Copied!';
		setTimeout(() => (btn.textContent = original), 1500);
	} catch (err) {
		// Clipboard blocked — drop the format into the paste box so it can be copied by hand
		el('pasteArea').classList.remove('hidden');
		el('pasteJsonInput').value = text;
		el('pasteJsonInput').select();
	}
});

const dropZone = el('dropZone');
['dragenter', 'dragover'].forEach((evt) =>
	dropZone.addEventListener(evt, (e) => {
		if (!e.dataTransfer.types.includes('Files')) return;
		e.preventDefault();
		dropZone.classList.add('drag-over');
	})
);
['dragleave', 'dragend'].forEach((evt) =>
	dropZone.addEventListener(evt, (e) => {
		if (e.target === dropZone) dropZone.classList.remove('drag-over');
	})
);
dropZone.addEventListener('drop', async (e) => {
	if (!e.dataTransfer.types.includes('Files')) return; // let internal card-reorder drops pass through untouched
	e.preventDefault();
	dropZone.classList.remove('drag-over');
	await uploadImageFiles([...e.dataTransfer.files]);
});

// ---------------------------------------------------------------------------
// Copy all captions (in current order) to clipboard, ready for ElevenLabs
// ---------------------------------------------------------------------------

el('copyCaptionsBtn').addEventListener('click', async () => {
	const text = (projectData.slides || [])
		.map((s) => (s.caption || '').trim())
		.filter(Boolean)
		.join('\n\n');
	if (!text) {
		el('status').textContent = 'No captions to copy yet.';
		return;
	}
	try {
		await navigator.clipboard.writeText(text);
		const btn = el('copyCaptionsBtn');
		const original = btn.textContent;
		btn.textContent = 'Copied!';
		setTimeout(() => (btn.textContent = original), 1500);
	} catch (err) {
		el('status').textContent = 'Could not access clipboard — select and copy manually.';
	}
});

// ---------------------------------------------------------------------------
// Project setup / creation
// ---------------------------------------------------------------------------

el('newProjectBtn').addEventListener('click', async () => {
	const title = el('newProjectTitle').value.trim();
	if (!title) return;
	const {slug} = await api('/projects', {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({title}),
	});
	await refreshProjectList(slug);
	el('newProjectTitle').value = '';
	loadProject(slug);
});

el('projectSelect').addEventListener('change', (e) => {
	if (e.target.value) loadProject(e.target.value);
});

el('narrationInput').addEventListener('change', async (e) => {
	if (!currentSlug || !e.target.files[0]) return;
	const form = new FormData();
	form.append('files', e.target.files[0]);
	const {uploaded, duration, waveformUrl} = await api(`/projects/${currentSlug}/upload?kind=audio&role=narration`, {
		method: 'POST',
		body: form,
	});
	projectData.narrationAudio = `projects/${currentSlug}/audio/${uploaded[0]}`;
	projectData.narrationAudioDuration = duration || null;
	projectData.narrationWaveformUrl = waveformUrl || null;
	renderTimeline();
});

el('musicInput').addEventListener('change', async (e) => {
	if (!currentSlug || !e.target.files[0]) return;
	const form = new FormData();
	form.append('files', e.target.files[0]);
	const {uploaded} = await api(`/projects/${currentSlug}/upload?kind=audio`, {
		method: 'POST',
		body: form,
	});
	projectData.musicAudio = `projects/${currentSlug}/audio/${uploaded[0]}`;
});

// ---------------------------------------------------------------------------
// Timeline: waveform + draggable duration dividers + playback preview
// ---------------------------------------------------------------------------

function weightedAutoFitDurations() {
	const slides = projectData.slides || [];
	const total = projectData.narrationAudioDuration
		? Math.max(2, projectData.narrationAudioDuration - (projectData.engagementPrompt ? projectData.outroDuration || 2.2 : 0))
		: slides.reduce((sum, s) => sum + (s.duration || 4), 0);
	const weights = slides.map((s) => Math.max(1, (s.caption || '').length));
	const wsum = weights.reduce((a, b) => a + b, 0) || 1;
	const minS = 1.6;
	let allocated = weights.map((w) => Math.max(minS, (w / wsum) * total));
	const asum = allocated.reduce((a, b) => a + b, 0) || 1;
	const scale = total / asum;
	return allocated.map((d) => Math.round(d * scale * 100) / 100);
}

el('autoFitBtn').addEventListener('click', () => {
	if (!projectData.slides || !projectData.slides.length) return;
	pushUndo();
	const fitted = weightedAutoFitDurations();
	projectData.slides.forEach((s, i) => (s.duration = fitted[i]));
	projectData.autoFitAudio = true;
	renderTimeline();
});

function boundariesFromSlides() {
	const slides = projectData.slides || [];
	const boundaries = [0];
	let acc = 0;
	slides.forEach((s) => {
		acc += s.duration || 4;
		boundaries.push(Math.round(acc * 100) / 100);
	});
	return boundaries;
}

function renderTimeline() {
	const wrap = el('timelineWrap');
	const slides = projectData.slides || [];
	if (!projectData.narrationAudio || !slides.length) {
		wrap.classList.add('hidden');
		return;
	}
	wrap.classList.remove('hidden');

	const audioEl = el('timelineAudio');
	const audioSrc = `/projects-raw/${currentSlug}/audio/${projectData.narrationAudio.split('/').pop()}`;
	if (!audioEl.src.endsWith(audioSrc)) audioEl.src = audioSrc;

	const waveImg = el('timelineWaveform');
	if (projectData.narrationWaveformUrl) waveImg.src = projectData.narrationWaveformUrl;

	const boundaries = boundariesFromSlides();
	const total = boundaries[boundaries.length - 1] || 1;

	const segWrap = el('timelineSegments');
	segWrap.innerHTML = '';
	slides.forEach((s, i) => {
		const widthPct = ((boundaries[i + 1] - boundaries[i]) / total) * 100;
		const seg = document.createElement('div');
		seg.className = 'seg';
		seg.style.width = `${widthPct}%`;
		seg.innerHTML = `<span class="seg-num">${i + 1}</span><span class="seg-caption" data-seg="${i}">${
			escapeHtml((s.caption || '').trim())
		}</span>`;
		segWrap.appendChild(seg);
	});

	const handleWrap = el('timelineHandles');
	handleWrap.innerHTML = '';
	for (let i = 1; i < boundaries.length - 1; i++) {
		const handle = document.createElement('div');
		handle.className = 'timeline-handle';
		handle.style.left = `${(boundaries[i] / total) * 100}%`;
		handle.dataset.index = i;
		attachHandleDrag(handle, i, total);
		handleWrap.appendChild(handle);
	}

	const labels = el('timelineLabels');
	labels.innerHTML = '';
	slides.forEach((s, i) => {
		const widthPct = ((boundaries[i + 1] - boundaries[i]) / total) * 100;
		const label = document.createElement('div');
		label.className = 'seg-label';
		label.style.width = `${widthPct}%`;
		const caption = (s.caption || '').trim();
		label.innerHTML = `<span class="seg-dur">${(boundaries[i + 1] - boundaries[i]).toFixed(1)}s</span>${
			caption ? `<span class="seg-label-cap">${escapeHtml(caption)}</span>` : '<span class="seg-label-cap muted">(no caption)</span>'
		}`;
		labels.appendChild(label);
	});
}

// Live-update the caption text shown on a timeline segment while the user types
// in a card, without a full timeline re-render (keeps typing smooth).
function updateTimelineCaption(index, text) {
	const seg = document.querySelector(`.seg-caption[data-seg="${index}"]`);
	if (seg) seg.textContent = (text || '').trim();
	const labels = el('timelineLabels');
	const label = labels ? labels.children[index] : null;
	const cap = label ? label.querySelector('.seg-label-cap') : null;
	if (cap) {
		const clean = (text || '').trim();
		cap.textContent = clean || '(no caption)';
		cap.classList.toggle('muted', !clean);
	}
}

function attachHandleDrag(handle, boundaryIndex, total) {
	const timeline = el('timeline');

	const onMove = (clientX) => {
		const rect = timeline.getBoundingClientRect();
		let pct = (clientX - rect.left) / rect.width;
		pct = Math.max(0, Math.min(1, pct));
		let t = pct * total;

		const boundaries = boundariesFromSlides();
		const minGap = 0.3; // seconds — keep segments from collapsing to nothing
		const lowerLimit = boundaries[boundaryIndex - 1] + minGap;
		const upperLimit = boundaries[boundaryIndex + 1] - minGap;
		t = Math.max(lowerLimit, Math.min(upperLimit, t));

		boundaries[boundaryIndex] = Math.round(t * 100) / 100;
		// re-derive slide durations from the updated boundaries
		for (let i = 0; i < projectData.slides.length; i++) {
			projectData.slides[i].duration = Math.round((boundaries[i + 1] - boundaries[i]) * 100) / 100;
		}
		projectData.autoFitAudio = false; // manual override once the user drags
		renderTimeline();
	};

	handle.addEventListener('mousedown', (e) => {
		e.preventDefault();
		pushUndo();
		handle.classList.add('dragging');
		const onMouseMove = (ev) => onMove(ev.clientX);
		const onMouseUp = () => {
			handle.classList.remove('dragging');
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		};
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
	});

	handle.addEventListener('touchstart', (e) => {
		pushUndo();
		handle.classList.add('dragging');
		const onTouchMove = (ev) => onMove(ev.touches[0].clientX);
		const onTouchEnd = () => {
			handle.classList.remove('dragging');
			document.removeEventListener('touchmove', onTouchMove);
			document.removeEventListener('touchend', onTouchEnd);
		};
		document.addEventListener('touchmove', onTouchMove);
		document.addEventListener('touchend', onTouchEnd);
	});
}

// click-to-seek on the timeline (ignoring handle drags) + moving playhead
el('timeline').addEventListener('click', (e) => {
	if (e.target.classList.contains('timeline-handle')) return;
	const audioEl = el('timelineAudio');
	if (!audioEl.duration) return;
	const rect = el('timeline').getBoundingClientRect();
	const pct = (e.clientX - rect.left) / rect.width;
	audioEl.currentTime = pct * audioEl.duration;
});

el('timelineAudio').addEventListener('timeupdate', (e) => {
	const audioEl = e.target;
	if (!audioEl.duration) return;
	const pct = (audioEl.currentTime / audioEl.duration) * 100;
	el('timelinePlayhead').style.left = `${pct}%`;
});

function resetPlayhead() {
	el('timelinePlayhead').style.left = '0%';
}

// ---------------------------------------------------------------------------
// Save / Generate with progress bar
// ---------------------------------------------------------------------------

function collectFormIntoProjectData() {
	projectData.engagementPrompt = el('engagementPrompt').value;
	projectData.channelName = el('channelName').value;
	projectData.musicVolume = parseFloat(el('musicVolume').value);
}

async function saveProject() {
	collectFormIntoProjectData();
	await api(`/projects/${currentSlug}/slides`, {
		method: 'PUT',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify(projectData),
	});
}

el('saveBtn').addEventListener('click', async () => {
	await saveProject();
	el('status').textContent = 'Saved.';
});

function resetProgressUI() {
	if (statusPollTimer) clearInterval(statusPollTimer);
	el('progressWrap').classList.add('hidden');
	el('progressFill').style.width = '0%';
	el('progressLabel').textContent = '';
	el('generateBtn').disabled = false;
}

const STAGE_LABELS = {
	starting: 'Starting…',
	bundling: 'Bundling the video template…',
	'selecting-composition': 'Preparing composition…',
	rendering: 'Rendering frames…',
	done: 'Done.',
	error: 'Failed.',
};

el('generateBtn').addEventListener('click', async () => {
	await saveProject();

	el('generateBtn').disabled = true;
	el('status').textContent = '';
	el('progressWrap').classList.remove('hidden');
	el('progressFill').style.width = '0%';
	el('progressLabel').textContent = 'Starting…';

	const startRes = await api(`/projects/${currentSlug}/generate`, {method: 'POST'});
	if (startRes.error) {
		el('progressLabel').textContent = `Error: ${startRes.error}`;
		el('generateBtn').disabled = false;
		return;
	}

	statusPollTimer = setInterval(async () => {
		const status = await api(`/projects/${currentSlug}/generate/status`);
		const pct = Math.round((status.progress || 0) * 100);
		el('progressFill').style.width = `${pct}%`;
		el('progressLabel').textContent = `${STAGE_LABELS[status.stage] || status.stage} (${pct}%)`;

		if (status.done) {
			clearInterval(statusPollTimer);
			el('generateBtn').disabled = false;
			if (status.error) {
				el('progressLabel').textContent = `Error: ${status.error}`;
				el('status').textContent = `Error: ${status.error}`;
				return;
			}
			el('progressFill').style.width = '100%';
			el('progressLabel').textContent = 'Done.';
			el('status').textContent = 'Video ready.';
			const video = el('preview');
			video.src = status.outputUrl;
			video.classList.remove('hidden');
		}
	}, 700);
});

// ---------------------------------------------------------------------------
// Undo wiring: button, keyboard shortcut, and snapshots for the section 2/4
// fields (kept live on projectData so undo can restore them too)
// ---------------------------------------------------------------------------

['engagementPrompt', 'channelName'].forEach((id) => {
	const field = el(id);
	field.addEventListener('focus', pushUndo);
	field.addEventListener('input', () => {
		if (!projectData) return;
		if (id === 'engagementPrompt') projectData.engagementPrompt = field.value;
		else projectData.channelName = field.value;
	});
});
el('musicVolume').addEventListener('focus', pushUndo);
el('musicVolume').addEventListener('input', () => {
	if (projectData) projectData.musicVolume = parseFloat(el('musicVolume').value);
});

el('undoBtn').addEventListener('click', undo);

document.addEventListener('keydown', (e) => {
	if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return;
	// Inside a text field, let the browser's native text-undo run instead.
	const t = e.target;
	if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
	e.preventDefault();
	undo();
});

refreshProjectList();
