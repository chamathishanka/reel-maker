// Voiceover. edge-tts (via msedge-tts, no Python) is the default; a Piper hook
// is stubbed for the commercial-safe production swap (see the plan doc §9).
// Interface: synthesize(text, outPath) -> { path, wordBoundaries }.
//
// edge-tts also streams word-boundary timestamps, which we capture so captions
// can later be timed to the spoken audio instead of estimated.

import fs from 'fs';
import path from 'path';
import {MsEdgeTTS, OUTPUT_FORMAT} from 'msedge-tts';
import {optionalEnv, requireEnv} from './env.mjs';

// Confident US news voice suited to finance. Override with STOCK_TTS_VOICE.
const EDGE_VOICE = optionalEnv('STOCK_TTS_VOICE', 'en-US-ChristopherNeural');

// ElevenLabs (higher quality). voice_id + model are configurable.
const ELEVEN_VOICE_ID = optionalEnv('STOCK_ELEVEN_VOICE_ID', '');
const ELEVEN_MODEL = optionalEnv('STOCK_ELEVEN_MODEL', 'eleven_multilingual_v2');

async function elevenSynthesize(text, outPath) {
	const key = requireEnv('ELEVENLAB_API_KEY');
	if (!ELEVEN_VOICE_ID) {
		throw new Error('Missing STOCK_ELEVEN_VOICE_ID (the Charles voice id).');
	}
	const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=mp3_44100_128`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg'},
		body: JSON.stringify({
			text,
			model_id: ELEVEN_MODEL,
			voice_settings: {stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true},
		}),
	});
	if (!res.ok) {
		const err = await res.text().catch(() => '');
		throw new Error(`ElevenLabs failed: ${res.status} ${res.statusText}${err ? ` — ${err.slice(0, 300)}` : ''}`);
	}
	fs.mkdirSync(path.dirname(outPath), {recursive: true});
	fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
	// ElevenLabs doesn't stream word boundaries here; captions use estimated timing.
	return {path: outPath, wordBoundaries: []};
}

async function edgeSynthesize(text, outPath) {
	const tts = new MsEdgeTTS();
	await tts.setMetadata(EDGE_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

	fs.mkdirSync(path.dirname(outPath), {recursive: true});
	const {audioStream, metadataStream} = tts.toStream(text);

	const wordBoundaries = [];
	if (metadataStream) {
		metadataStream.on('data', (chunk) => {
			// Each metadata chunk describes a word boundary with an offset (100ns
			// ticks) and duration. Normalise to seconds.
			try {
				const meta = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
				const boundary = meta?.Metadata?.[0]?.Data;
				if (boundary?.Offset != null) {
					wordBoundaries.push({
						text: boundary.text?.Text ?? '',
						start: boundary.Offset / 1e7,
						duration: (boundary.Duration ?? 0) / 1e7,
					});
				}
			} catch {
				/* non-JSON metadata frames are ignored */
			}
		});
	}

	await new Promise((resolve, reject) => {
		const file = fs.createWriteStream(outPath);
		audioStream.pipe(file);
		audioStream.on('error', reject);
		file.on('error', reject);
		file.on('finish', resolve);
	});

	tts.close?.();
	return {path: outPath, wordBoundaries};
}

// eslint-disable-next-line no-unused-vars
async function piperSynthesize(text, outPath) {
	throw new Error(
		'Piper TTS not wired up yet — set STOCK_TTS_ENGINE=edge for now (see plan §9).',
	);
}

// Public entry — dispatch on STOCK_TTS_ENGINE (default edge).
export async function synthesize(text, outPath) {
	const engine = optionalEnv('STOCK_TTS_ENGINE', 'edge').toLowerCase();
	if (engine === 'elevenlabs') return elevenSynthesize(text, outPath);
	if (engine === 'piper') return piperSynthesize(text, outPath);
	return edgeSynthesize(text, outPath);
}

export {EDGE_VOICE};
