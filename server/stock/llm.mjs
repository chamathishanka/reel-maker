// LLM adapter. Default provider is Google Gemini (free tier); the interface is
// deliberately tiny — generateJson(system, user, schema) — so swapping to
// Claude/Groq later means adding one function, not touching the pipeline.

import {requireEnv, optionalEnv} from './env.mjs';

// Which model to use — override with GEMINI_MODEL. gemini-2.5-flash is a stable
// free-tier model; gemini-flash-latest tracks the current recommended one.
const GEMINI_MODEL = optionalEnv('GEMINI_MODEL', 'gemini-2.5-flash');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geminiGenerateJson(system, user, schema) {
	const key = requireEnv('GEMINI_API_KEY');
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
	const body = {
		systemInstruction: {parts: [{text: system}]},
		contents: [{role: 'user', parts: [{text: user}]}],
		generationConfig: {
			temperature: 0.9, // some variety day-to-day so scripts aren't templated
			responseMimeType: 'application/json',
			...(schema ? {responseSchema: schema} : {}),
		},
	};

	// Gemini free tier throttles/overloads (429/503) intermittently — retry with
	// backoff so an unattended cron run survives a transient spike.
	const MAX_ATTEMPTS = 4;
	let res;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		res = await fetch(url, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		});
		if (res.ok) break;
		const retriable = res.status === 429 || res.status === 503;
		if (!retriable || attempt === MAX_ATTEMPTS) {
			const errText = await res.text().catch(() => '');
			throw new Error(
				`Gemini ${GEMINI_MODEL} failed: ${res.status} ${res.statusText}${
					errText ? ` — ${errText.slice(0, 300)}` : ''
				}`,
			);
		}
		const waitMs = 1500 * 2 ** (attempt - 1); // 1.5s, 3s, 6s
		console.warn(`[llm] ${res.status} from Gemini — retrying in ${waitMs}ms (attempt ${attempt}/${MAX_ATTEMPTS - 1})`);
		await sleep(waitMs);
	}

	const data = await res.json();
	const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!text) {
		const reason = data?.candidates?.[0]?.finishReason || 'unknown';
		throw new Error(`Gemini returned no text (finishReason: ${reason}).`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 200)}`);
	}
}

// Public entry — dispatches on STOCK_LLM_PROVIDER (default gemini).
export async function generateJson(system, user, schema) {
	const provider = optionalEnv('STOCK_LLM_PROVIDER', 'gemini').toLowerCase();
	switch (provider) {
		case 'gemini':
			return geminiGenerateJson(system, user, schema);
		default:
			throw new Error(
				`Unknown STOCK_LLM_PROVIDER "${provider}" (supported: gemini).`,
			);
	}
}

export {GEMINI_MODEL};
