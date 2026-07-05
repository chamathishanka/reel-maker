// US Stock News workflow — tab switching + Generate button + progress polling
// + results with copyable captions. Kept separate from app.js (the Aussie flow)
// so the two never interfere; only the shared header tab bar links them.

(function () {
	const $ = (id) => document.getElementById(id);
	const TYPE_LABEL = {'top-mover': 'Top Mover', 'market-recap': 'Market Recap', headline: 'Headline'};

	// --- tab switching (CSS handles visibility via body.mode-stock) ------------
	const title = $('appTitle');
	document.querySelectorAll('.wf-tab').forEach((btn) => {
		btn.addEventListener('click', () => {
			document.querySelectorAll('.wf-tab').forEach((b) => b.classList.remove('active'));
			btn.classList.add('active');
			const stock = btn.dataset.wf === 'stock';
			document.body.classList.toggle('mode-stock', stock);
			title.textContent = stock ? 'US Stock News Pipeline' : 'Aussie Nostalgia Pipeline';
		});
	});

	// --- generate + poll -------------------------------------------------------
	const dateInput = $('stockDate');
	const genBtn = $('stockGenerateBtn');
	const progWrap = $('stockProgressWrap');
	const progFill = $('stockProgressFill');
	const progLabel = $('stockProgressLabel');
	const statusEl = $('stockStatus');
	const resultsPanel = $('stockResultsPanel');
	const reelsEl = $('stockReels');
	const folderLink = $('stockFolderLink');

	const todayStr = () => new Date().toISOString().slice(0, 10);
	if (dateInput) dateInput.value = todayStr();

	let polling = null;

	async function copy(text, btn) {
		try {
			await navigator.clipboard.writeText(text);
			const old = btn.textContent;
			btn.textContent = '✓ Copied';
			setTimeout(() => (btn.textContent = old), 1400);
		} catch {
			btn.textContent = 'Copy failed';
		}
	}

	function reelCard(date, r, i) {
		const num = String(i + 1).padStart(2, '0');
		const videoUrl = `/output/stock/${date}/${r.file}`;
		const caption = (r.fbCaption || '').trim();
		const hashtags = (r.hashtags || []).join(' ');
		const captionFull = [caption, hashtags].filter(Boolean).join('\n\n');

		const card = document.createElement('div');
		card.className = 'stock-reel-card';
		card.innerHTML = `
			<div class="stock-reel-head">
				<span class="stock-badge stock-badge-${r.type}">${TYPE_LABEL[r.type] || r.type}</span>
				<span class="stock-reel-title">${num} · ${escapeHtml(r.title || '')}</span>
			</div>
			<div class="stock-reel-body">
				<video class="stock-reel-video" src="${videoUrl}" controls preload="metadata"></video>
				<div class="stock-reel-meta">
					<div class="stock-tickers">${(r.tickers || []).map((t) => `<span class="stock-tick">${t}</span>`).join('')}</div>
					<label class="stock-cap-label">Caption <button class="secondary stock-copy" data-copy="caption">Copy caption</button></label>
					<textarea class="stock-caption" readonly rows="4">${escapeHtml(captionFull)}</textarea>
					<div class="stock-reel-links">
						<a href="${videoUrl}" download>⬇ Download .mp4</a>
					</div>
				</div>
			</div>`;
		card.querySelector('[data-copy="caption"]').addEventListener('click', (e) => copy(captionFull, e.target));
		return card;
	}

	function renderResults(job) {
		reelsEl.innerHTML = '';
		(job.reels || []).forEach((r, i) => reelsEl.appendChild(reelCard(job.date, r, i)));
		resultsPanel.classList.toggle('hidden', !(job.reels && job.reels.length));
		if (job.indexUrl) {
			folderLink.href = job.indexUrl;
			folderLink.classList.remove('hidden');
		}
	}

	function setProgress(job) {
		progWrap.classList.remove('hidden');
		progFill.style.width = `${Math.round((job.progress || 0) * 100)}%`;
		progLabel.textContent = job.error ? `Error: ${job.error}` : prettyStage(job.stage);
	}

	function prettyStage(stage) {
		return (
			{
				starting: 'Starting…',
				fetching: 'Fetching market data…',
				scripting: 'Writing scripts…',
				voicing: 'Generating voiceover…',
				bundling: 'Bundling renderer…',
				'selecting-composition': 'Preparing…',
				rendering: 'Rendering video…',
				delivering: 'Writing index.md…',
				done: '✓ Done',
			}[stage] || stage
		);
	}

	async function poll(date) {
		const res = await fetch(`/api/stock/status?date=${encodeURIComponent(date)}`);
		const job = await res.json();
		setProgress(job);
		if (job.done) {
			clearInterval(polling);
			polling = null;
			genBtn.disabled = false;
			if (job.error) {
				statusEl.textContent = job.error;
			} else {
				statusEl.textContent = `Rendered ${job.reels ? job.reels.length : 0} reel(s) → output/stock/${date}/`;
				renderResults(job);
			}
		}
	}

	genBtn?.addEventListener('click', async () => {
		const date = dateInput.value || todayStr();
		genBtn.disabled = true;
		statusEl.textContent = '';
		resultsPanel.classList.add('hidden');
		folderLink.classList.add('hidden');
		setProgress({progress: 0, stage: 'starting'});
		try {
			const res = await fetch('/api/stock/generate', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({date}),
			});
			if (!res.ok) {
				const e = await res.json().catch(() => ({}));
				throw new Error(e.error || `HTTP ${res.status}`);
			}
			if (polling) clearInterval(polling);
			polling = setInterval(() => poll(date), 1200);
		} catch (err) {
			genBtn.disabled = false;
			statusEl.textContent = String(err.message || err);
		}
	});

	function escapeHtml(s) {
		return String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
	}
})();
