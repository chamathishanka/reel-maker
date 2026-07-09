// US market calendar + Eastern-Time wall-clock helpers.
//
// Everything the unattended (GitHub Actions) run needs in order to answer:
//   - is the US market even open today?  (weekend / NYSE holiday)
//   - what UTC instant is "19:30 ET on <date>"?
//
// GitHub Actions cron is UTC-only and has no DST handling, so post slots MUST
// be expressed as ET wall-clock and converted here — a fixed UTC offset would
// silently drift by an hour twice a year.

const ET = 'America/New_York';

// Offset (ms) between a given instant and the same clock reading interpreted as
// UTC. For EDT this is +4h, for EST +5h.
function etOffsetMs(date) {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone: ET,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
	const p = Object.fromEntries(
		dtf
			.formatToParts(date)
			.filter((x) => x.type !== 'literal')
			.map((x) => [x.type, Number(x.value)]),
	);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return date.getTime() - asUtc;
}

// Convert an ET wall-clock reading into the real UTC Date. Two passes so the
// result is still correct when the naive guess lands on the other side of a
// DST transition from the true instant.
export function etWallClockToDate(year, month, day, hour, minute = 0) {
	const naive = Date.UTC(year, month - 1, day, hour, minute);
	let ts = naive + etOffsetMs(new Date(naive));
	ts = naive + etOffsetMs(new Date(ts));
	return new Date(ts);
}

// Today's date (YYYY-MM-DD) as it reads on an ET wall clock, not in UTC. At
// 22:15 UTC these agree, but a badly delayed run past 00:00 UTC would otherwise
// jump a day and fetch the wrong session.
export function etDateStr(date = new Date()) {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: ET,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date);
}

// The ET date string, shifted by whole days.
export function addDays(dateStr, days) {
	const [y, m, d] = dateStr.split('-').map(Number);
	const t = Date.UTC(y, m - 1, d) + days * 864e5;
	return new Date(t).toISOString().slice(0, 10);
}

// NYSE full-day closures. Hardcoded because there's no free calendar API worth
// a dependency — but this list is NOT self-maintaining. Extend it each year.
// The stale-quote check in the pipeline is the real backstop if it goes stale.
const NYSE_HOLIDAYS = new Set([
	// 2026
	'2026-01-01', // New Year's Day
	'2026-01-19', // MLK Jr. Day
	'2026-02-16', // Washington's Birthday
	'2026-04-03', // Good Friday
	'2026-05-25', // Memorial Day
	'2026-06-19', // Juneteenth
	'2026-07-03', // Independence Day (observed, Jul 4 is a Saturday)
	'2026-09-07', // Labor Day
	'2026-11-26', // Thanksgiving
	'2026-12-25', // Christmas
	// 2027
	'2027-01-01',
	'2027-01-18',
	'2027-02-15',
	'2027-03-26', // Good Friday
	'2027-05-31',
	'2027-06-18', // Juneteenth (observed)
	'2027-07-05', // Independence Day (observed)
	'2027-09-06',
	'2027-11-25',
	'2027-12-24', // Christmas (observed)
]);

export function isNyseHoliday(dateStr) {
	return NYSE_HOLIDAYS.has(dateStr);
}

export function isWeekend(dateStr) {
	const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
	return day === 0 || day === 6;
}

// A regular US trading session — the only days a "today's movers" reel makes
// sense. Weekends still produce a weekly wrap upstream; holidays produce nothing.
export function isTradingDay(dateStr) {
	return !isWeekend(dateStr) && !isNyseHoliday(dateStr);
}

// Backstop for the hardcoded holiday list above: ask the data itself whether it
// is actually from the session we think it is. Finnhub stamps each quote with
// the last trade time (`quoteTime`, unix seconds); if the freshest quote in the
// batch isn't from `tradingDate` in ET, the market didn't trade that day (or the
// feed is lagging) and a "today's movers" reel would be a lie.
//
// Returns {stale, quoteDate, checked} — `checked:false` when no quote carried a
// timestamp, in which case we can't judge and the caller should not block.
export function checkQuoteFreshness(quotes = [], tradingDate) {
	const times = quotes.map((q) => q.quoteTime).filter((t) => typeof t === 'number' && t > 0);
	if (!times.length) return {stale: false, checked: false};
	const newest = new Date(Math.max(...times) * 1000);
	const quoteDate = etDateStr(newest);
	return {stale: quoteDate !== tradingDate, quoteDate, checked: true};
}

// Post slots, as ET wall-clock, keyed by the reel `type` the scriptwriter emits.
// dayOffset is relative to the trading date the reels describe.
//
//   top-mover    same day 19:30 ET — strongest hook into the evening Reels peak
//   headline     next day 08:00 ET — pre-market/commute, news still fresh
//   market-recap next day 12:30 ET — lunch scroll, recap content ages well
export const SLOTS = {
	'top-mover': {dayOffset: 0, hour: 19, minute: 30},
	headline: {dayOffset: 1, hour: 8, minute: 0},
	'market-recap': {dayOffset: 1, hour: 12, minute: 30},
};

// Weekend wrap slots. The weekly run happens Saturday morning and emits two
// reels (top-mover + market-recap — the scriptwriter omits `headline` in weekly
// mode), so offsetting the recap by a day puts one video on Saturday and one on
// Sunday. `dayOffset` is therefore relative to the SATURDAY the run fires on.
export const WEEKEND_SLOTS = {
	'top-mover': {dayOffset: 0, hour: 11, minute: 0}, // Sat late-morning scroll
	'market-recap': {dayOffset: 1, hour: 11, minute: 0}, // Sun week-in-review
};

// Fallback for any reel type not in the table: stagger through the next day's
// afternoon so an unexpected type still gets a sane, non-colliding slot.
const FALLBACK_BASE = {dayOffset: 1, hour: 15, minute: 0};

export function slotForReel(type, tradingDate, fallbackIndex = 0, {weekly = false} = {}) {
	const table = weekly ? WEEKEND_SLOTS : SLOTS;
	const slot = table[type] || {
		...FALLBACK_BASE,
		hour: FALLBACK_BASE.hour + fallbackIndex,
	};
	const dateStr = addDays(tradingDate, slot.dayOffset);
	const [y, m, d] = dateStr.split('-').map(Number);
	return etWallClockToDate(y, m, d, slot.hour, slot.minute);
}
