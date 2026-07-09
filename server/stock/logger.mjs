// Tees console output to a per-day log file so a run can always be inspected
// after the fact (output/stock/<date>/pipeline.log), not just in the terminal
// that happens to be running the server.

import fs from 'fs';
import path from 'path';

const fmt = (args) =>
	args
		.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
		.join(' ');

// Returns a detach() function — always call it in a finally block.
export function attachFileLogger(logPath) {
	fs.mkdirSync(path.dirname(logPath), {recursive: true});
	const stream = fs.createWriteStream(logPath, {flags: 'a'});
	const orig = {log: console.log, warn: console.warn, error: console.error};

	const write = (level, args) => {
		try {
			stream.write(`[${new Date().toISOString()}] ${level} ${fmt(args)}\n`);
		} catch {
			/* never let logging break a render */
		}
	};

	console.log = (...a) => { write('INFO', a); orig.log(...a); };
	console.warn = (...a) => { write('WARN', a); orig.warn(...a); };
	console.error = (...a) => { write('ERROR', a); orig.error(...a); };

	return function detach() {
		console.log = orig.log;
		console.warn = orig.warn;
		console.error = orig.error;
		stream.end();
	};
}
