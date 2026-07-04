// Stage 1 — FETCH. Pulls the raw market data one day's reels are built from:
// quotes for the watchlist, ranked movers, and news headlines.
//
// Two providers behind one interface, chosen by STOCK_DATA_PROVIDER:
//   - "finnhub" (default): quotes + news on the free tier; movers are computed
//     locally from per-ticker quotes (Finnhub free has no movers endpoint).
//   - "fmp": Financial Modeling Prep free tier; native movers + charts.
//
// Everything is cached to projects/stock/<date>/data.json so re-renders and
// script iteration don't burn API calls (respects Finnhub's ~300/day limit).

import fs from 'fs';
import path from 'path';
import {pathToFileURL} from 'url';
import {requireEnv, optionalEnv, ROOT} from './env.mjs';

const DATA_DIR = path.join(ROOT, 'data', 'stock');
const PROJECTS_DIR = path.join(ROOT, 'projects', 'stock');

const universe = JSON.parse(
	fs.readFileSync(path.join(DATA_DIR, 'universe.json'), 'utf8'),
).tickers;
const tickerMap = JSON.parse(
	fs.readFileSync(path.join(DATA_DIR, 'ticker-map.json'), 'utf8'),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendlyName(ticker) {
	return tickerMap[ticker]?.name || ticker;
}

async function fetchJson(url, label) {
	const res = await fetch(url);
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(
			`${label} failed: ${res.status} ${res.statusText}${
				body ? ` — ${body.slice(0, 200)}` : ''
			}`,
		);
	}
	return res.json();
}

// ---------------------------------------------------------------------------
// Finnhub provider
// ---------------------------------------------------------------------------
const finnhub = {
	async getQuotes(tickers) {
		const key = requireEnv('FINNHUB_API_KEY');
		const out = [];
		// Chunk to stay well under 60 calls/min and avoid bursty rejections.
		const CHUNK = 8;
		for (let i = 0; i < tickers.length; i += CHUNK) {
			const batch = tickers.slice(i, i + CHUNK);
			const results = await Promise.all(
				batch.map(async (ticker) => {
					try {
						const q = await fetchJson(
							`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`,
							`quote ${ticker}`,
						);
						// Finnhub quote: c=current, d=change, dp=percent, pc=prevClose
						if (q && typeof q.c === 'number' && q.c > 0) {
							return {
								ticker,
								name: friendlyName(ticker),
								price: q.c,
								change: q.d,
								changePct: q.dp,
								prevClose: q.pc,
								high: q.h,
								low: q.l,
								open: q.o,
							};
						}
						return null;
					} catch (err) {
						console.warn(`[fetch] ${err.message}`);
						return null;
					}
				}),
			);
			out.push(...results.filter(Boolean));
			if (i + CHUNK < tickers.length) await sleep(1200);
		}
		return out;
	},

	async getMovers(quotes) {
		return rankMovers(quotes);
	},

	async getMarketNews() {
		const key = requireEnv('FINNHUB_API_KEY');
		const news = await fetchJson(
			`https://finnhub.io/api/v1/news?category=general&token=${key}`,
			'market news',
		);
		return (news || []).slice(0, 15).map(normalizeFinnhubNews);
	},

	async getCompanyNews(ticker) {
		const key = requireEnv('FINNHUB_API_KEY');
		const to = new Date();
		const from = new Date(to.getTime() - 3 * 24 * 60 * 60 * 1000);
		const fmt = (d) => d.toISOString().slice(0, 10);
		const news = await fetchJson(
			`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fmt(
				from,
			)}&to=${fmt(to)}&token=${key}`,
			`company news ${ticker}`,
		);
		return (news || []).slice(0, 5).map(normalizeFinnhubNews);
	},
};

function normalizeFinnhubNews(n) {
	return {
		headline: n.headline,
		summary: n.summary,
		source: n.source,
		url: n.url,
		datetime: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
	};
}

// ---------------------------------------------------------------------------
// Financial Modeling Prep provider (secondary — free tier caveats below)
//
// FMP free tier reality (verified Jul 2026): the modern `stable/` quote endpoint
// works but some symbols are premium-locked (skipped here), and the news
// endpoints are premium-only (degrade to []). So FMP is only a viable *quotes*
// supplement on free — Finnhub stays the default for the news-driven pipeline.
// Note the field-name quirk: stable /quote returns `changePercentage`.
// ---------------------------------------------------------------------------
const fmp = {
	async getQuotes(tickers) {
		const key = requireEnv('FMP_API_KEY');
		const out = [];
		const CHUNK = 8;
		for (let i = 0; i < tickers.length; i += CHUNK) {
			const batch = tickers.slice(i, i + CHUNK);
			const results = await Promise.all(
				batch.map(async (ticker) => {
					try {
						const data = await fetchJson(
							`https://financialmodelingprep.com/stable/quote?symbol=${ticker}&apikey=${key}`,
							`fmp quote ${ticker}`,
						);
						const q = Array.isArray(data) ? data[0] : data;
						if (q && typeof q.price === 'number') {
							return {
								ticker: q.symbol,
								name: friendlyName(q.symbol),
								price: q.price,
								change: q.change,
								changePct: q.changePercentage,
								prevClose: q.previousClose,
								high: q.dayHigh,
								low: q.dayLow,
								open: q.open,
							};
						}
						return null;
					} catch (err) {
						// Premium-locked symbols on free tier return 402 — skip them.
						console.warn(`[fetch] ${err.message}`);
						return null;
					}
				}),
			);
			out.push(...results.filter(Boolean));
			if (i + CHUNK < tickers.length) await sleep(300);
		}
		return out;
	},

	async getMovers(quotes) {
		// Rank our own curated universe rather than FMP's native movers endpoint,
		// which on free tier is dominated by penny stocks and leveraged ETFs.
		return rankMovers(quotes);
	},

	async getMarketNews() {
		// FMP news endpoints are premium-only on the free tier.
		console.warn(
			'[fetch] FMP free tier has no news access — market news is empty. Use STOCK_DATA_PROVIDER=finnhub for headlines.',
		);
		return [];
	},

	async getCompanyNews() {
		return [];
	},
};

// ---------------------------------------------------------------------------
// Shared: rank movers from a list of quotes
// ---------------------------------------------------------------------------
function rankMovers(quotes) {
	const valid = quotes.filter((q) => typeof q.changePct === 'number');
	const byPct = [...valid].sort((a, b) => b.changePct - a.changePct);
	const gainers = byPct.filter((q) => q.changePct > 0).slice(0, 5);
	const losers = [...byPct]
		.filter((q) => q.changePct < 0)
		.reverse()
		.slice(0, 5);
	// "Most active" proxy: largest absolute % move (free tiers lack volume rank).
	const mostActive = [...valid]
		.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
		.slice(0, 5);
	// Top mover = the single biggest move in either direction (best hook material).
	const biggestUp = byPct[0];
	const biggestDown = byPct.at(-1);
	let topMover = null;
	if (byPct.length) {
		topMover =
			Math.abs(biggestUp.changePct) >= Math.abs(biggestDown.changePct)
				? biggestUp
				: biggestDown;
	}
	return {gainers, losers, mostActive, topMover};
}

function getProvider() {
	const name = optionalEnv('STOCK_DATA_PROVIDER', 'finnhub').toLowerCase();
	if (name === 'fmp') return {name, api: fmp};
	return {name: 'finnhub', api: finnhub};
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function fetchDailyData({date = todayStr(), useCache = true} = {}) {
	const dayDir = path.join(PROJECTS_DIR, date);
	const cachePath = path.join(dayDir, 'data.json');
	if (useCache && fs.existsSync(cachePath)) {
		return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
	}

	const {name: providerName, api} = getProvider();
	const quotes = await api.getQuotes(universe);
	if (!quotes.length) {
		throw new Error(
			'No quotes returned — check the API key and that the market data provider is reachable.',
		);
	}
	const movers = await api.getMovers(quotes);
	const marketNews = await api.getMarketNews();

	// Grounding for the mandatory "why": fetch company news for every featured
	// mover, not just the single top one — so recap/headline beats have a real
	// reason to cite instead of "no catalyst reported". Well under rate limits.
	const featured = [
		...movers.gainers.slice(0, 3),
		...movers.losers.slice(0, 3),
		...(movers.topMover ? [movers.topMover] : []),
	];
	const featuredTickers = [...new Set(featured.map((q) => q.ticker))];
	const moverNews = {};
	for (const ticker of featuredTickers) {
		try {
			moverNews[ticker] = await api.getCompanyNews(ticker);
		} catch (err) {
			console.warn(`[fetch] company news ${ticker}: ${err.message}`);
			moverNews[ticker] = [];
		}
	}

	const data = {
		date,
		provider: providerName,
		fetchedAt: new Date().toISOString(),
		quoteCount: quotes.length,
		quotes,
		movers,
		marketNews,
		moverNews,
		topMoverNews: movers.topMover ? moverNews[movers.topMover.ticker] || [] : [],
	};

	fs.mkdirSync(dayDir, {recursive: true});
	fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
	return data;
}

export function todayStr(d = new Date()) {
	return d.toISOString().slice(0, 10);
}

// Allow running directly: `node server/stock/fetch.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	fetchDailyData({useCache: false})
		.then((data) => {
			const {gainers, losers, topMover} = data.movers;
			console.log(`\nProvider: ${data.provider} | quotes: ${data.quoteCount}`);
			console.log(`\nTop mover: ${topMover?.name} (${topMover?.ticker}) ${fmtPct(topMover?.changePct)}`);
			console.log('\nGainers:');
			gainers.forEach((q) => console.log(`  ${q.ticker.padEnd(6)} ${fmtPct(q.changePct)}  $${q.price}`));
			console.log('\nLosers:');
			losers.forEach((q) => console.log(`  ${q.ticker.padEnd(6)} ${fmtPct(q.changePct)}  $${q.price}`));
			console.log(`\nMarket headlines: ${data.marketNews.length}`);
			data.marketNews.slice(0, 5).forEach((n) => console.log(`  - ${n.headline}`));
			console.log(`\nCached to projects/stock/${data.date}/data.json`);
		})
		.catch((err) => {
			console.error(`\n[fetch] ${err.message}\n`);
			process.exit(1);
		});
}

function fmtPct(p) {
	if (typeof p !== 'number') return 'n/a';
	return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}
