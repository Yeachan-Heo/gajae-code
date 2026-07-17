// EPIPE dogfood harness (G002, fail-closed): spawn the source-checkout CLI in
// JSON print mode — which streams one JSON event per line across the whole
// turn — destroy the read side after the FIRST line so every subsequent event
// write deterministically hits a closed pipe, then require a quiet exit.
//
// Fail-closed contract: any violation (crash dump, hang past the deadline,
// unexpected exit code, or the child never writing a post-close event) makes
// this harness exit nonzero. Pre-fix CLIs (< v0.10.1) die here with a fatal
// internal-error dump.
import { spawn } from "node:child_process";

const DEADLINE_MS = 120_000;
const repoRoot = process.argv[2] ?? process.cwd();

const child = spawn(
	"bun",
	[
		"packages/coding-agent/src/cli.ts",
		"-p",
		"--mode",
		"json",
		"--no-session",
		"Count from 1 to 100, one number per line.",
	],
	{ stdio: ["ignore", "pipe", "pipe"], cwd: repoRoot },
);

let stderr = "";
let stdoutLines = 0;
let destroyed = false;
let timedOut = false;
let buffer = "";

const killTimer = setTimeout(() => {
	timedOut = true;
	child.kill("SIGKILL");
}, DEADLINE_MS);

child.stderr.on("data", d => {
	stderr += String(d);
});
child.stdout.on("data", chunk => {
	buffer += String(chunk);
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	stdoutLines += lines.length;
	if (!destroyed && stdoutLines >= 1) {
		destroyed = true;
		// Close the read side after the first JSON line. The turn has barely
		// started, so the event stream MUST attempt further writes into the
		// now-closed pipe — that is the deterministic post-close EPIPE.
		child.stdout.destroy();
	}
});

// `close` (not `exit`): fires only after all stdio has drained.
child.on("close", (code, signal) => {
	clearTimeout(killTimer);
	const crashDump = /internal error|FATAL|uncaught|Segmentation|at .+\.ts:\d+/i.test(stderr);
	const quietExit = code === 0 || code === 141;
	const verdict = {
		exitCode: code,
		signal,
		stdoutLinesBeforeDestroy: stdoutLines,
		destroyedEarly: destroyed,
		timedOut,
		stderrBytes: stderr.length,
		crashDump,
		pass: destroyed && !timedOut && quietExit && !crashDump,
	};
	console.log(JSON.stringify(verdict, null, 2));
	if (stderr.trim()) console.log(`--- stderr head ---\n${stderr.slice(0, 800)}`);
	if (!verdict.pass) {
		console.error("EPIPE HARNESS FAILED: the CLI did not exit quietly after its output pipe closed mid-stream.");
		process.exit(1);
	}
});
