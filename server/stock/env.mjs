// Loads .env from the repo root into process.env using Node 22's native
// loader — no dotenv dependency. Safe to import many times (loads once).
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');

let loaded = false;
if (!loaded) {
	if (fs.existsSync(ENV_PATH)) {
		try {
			process.loadEnvFile(ENV_PATH);
		} catch (err) {
			console.warn(`[env] could not load .env: ${err.message}`);
		}
	}
	loaded = true;
}

// Read a required env var, throwing a friendly error if missing.
export function requireEnv(name) {
	const v = process.env[name];
	if (!v) {
		throw new Error(
			`Missing ${name}. Add it to ${ENV_PATH} (see .env.example).`,
		);
	}
	return v;
}

// Read an optional env var with a fallback.
export function optionalEnv(name, fallback = undefined) {
	return process.env[name] ?? fallback;
}

export {ROOT};
