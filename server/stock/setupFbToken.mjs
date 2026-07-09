// One-time helper: exchanges a short-lived User token (from Graph API
// Explorer) for a long-lived Page token and writes it straight to .env.
// Run locally — never paste tokens into chat, only into this command:
//
//   node server/stock/setupFbToken.mjs <short-lived-user-token>
//
// Needs FB_APP_ID / FB_APP_SECRET in .env (App ID isn't sensitive; App Secret
// is — add it to .env like any other key, it's gitignored).
//
// Prints only the resulting Page name/id for confirmation — never the token.

import fs from 'fs';
import path from 'path';
import {requireEnv, ROOT} from './env.mjs';

const GRAPH_BASE = 'https://graph.facebook.com/v23.0';
const ENV_PATH = path.join(ROOT, '.env');

async function graphGet(url) {
	const res = await fetch(url);
	const json = await res.json();
	if (!res.ok || json?.error) {
		throw new Error(json?.error?.message || `HTTP ${res.status}`);
	}
	return json;
}

function setEnvVar(name, value) {
	let text = fs.readFileSync(ENV_PATH, 'utf8');
	const line = `${name}=${value}`;
	const re = new RegExp(`^${name}=.*$`, 'm');
	text = re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
	fs.writeFileSync(ENV_PATH, text);
}

async function main() {
	const shortLivedToken = process.argv[2];
	if (!shortLivedToken) {
		console.error('Usage: node server/stock/setupFbToken.mjs <short-lived-user-token>');
		process.exit(1);
	}

	const appId = requireEnv('FB_APP_ID');
	const appSecret = requireEnv('FB_APP_SECRET');

	// 1. Exchange for a long-lived user token.
	const exchangeUrl =
		`${GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token` +
		`&client_id=${encodeURIComponent(appId)}` +
		`&client_secret=${encodeURIComponent(appSecret)}` +
		`&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`;
	const {access_token: longLivedUserToken} = await graphGet(exchangeUrl);

	// 2. Pull the Page (+ its own long-lived-derived token) from /me/accounts.
	const accounts = await graphGet(
		`${GRAPH_BASE}/me/accounts?access_token=${encodeURIComponent(longLivedUserToken)}`,
	);
	if (!accounts.data?.length) {
		throw new Error('No Pages found for this user token — check the token has pages_show_list granted.');
	}
	// If there's more than one Page, prefer one already matching FB_PAGE_ID, else take the first.
	const existingPageId = process.env.FB_PAGE_ID;
	const page =
		accounts.data.find((p) => p.id === existingPageId) || accounts.data[0];

	setEnvVar('FB_PAGE_ID', page.id);
	setEnvVar('FB_PAGE_ACCESS_TOKEN', page.access_token);

	console.log(`Saved Page token for "${page.name}" (id ${page.id}) to .env.`);
	if (accounts.data.length > 1) {
		console.log(`Note: you manage ${accounts.data.length} Pages; picked "${page.name}". Other Pages:`);
		for (const p of accounts.data) if (p.id !== page.id) console.log(`  - ${p.name} (${p.id})`);
	}
}

main().catch((err) => {
	console.error(`Failed: ${err.message}`);
	process.exit(1);
});
