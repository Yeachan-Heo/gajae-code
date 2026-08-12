import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// macOS `os.tmpdir()` resolves through the `/var -> /private/var` symlink, and the
// native owner-only primitive plus the session-storage reparse guard intentionally
// reject any symlinked path component. Production session roots live under a real
// home (`~/.gjc`) and never hit this, but tests create sessions under
// `mkdtemp(os.tmpdir())`, so every such path would trip the strict guards.
//
// Canonicalize the temp root once per test process so `os.tmpdir()` (and every
// `mkdtemp` derived from it) yields a symlink-free path that matches production.
// This is a no-op where `TMPDIR` is already canonical (e.g. Linux CI `/tmp`).
try {
	const current = os.tmpdir();
	const real = fs.realpathSync(current);
	if (real !== current) {
		process.env.TMPDIR = real;
		process.env.TMP = real;
		process.env.TEMP = real;
	}
} catch {
	// Leave the environment untouched if the temp root cannot be resolved.
}


// Isolate the agent directory for every test process. `getAgentDir()` (and
// therefore `Settings.isolated()` and every daemon-path helper) resolves the
// REAL `~/.gjc/agent` unless GJC_CODING_AGENT_DIR overrides it, so any test
// with filesystem side effects — notification daemon diagnostics, transition
// markers, unlink placeholders, the SDK session index — writes into the live
// operator state of the machine running `bun test`. On dev machines this
// corrupted the running Telegram daemon: leaked `transition-*` markers made
// dead-owner lock recovery report `left-contended` and give up.
//
// A fresh per-process mkdtemp keeps every such write inside the (already
// canonicalized) temp root. An ambient override that merely restates the
// DEFAULT agent dir gets no deference: a gjc parent process exports
// GJC_CODING_AGENT_DIR=<home>/<config>/agent into every child it spawns, so
// equality with the default carries no test intent — only an override that
// points somewhere else is an intentional pin and is honored.
const configuredAgentDir = process.env.GJC_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
const configDirName = process.env.GJC_CONFIG_DIR?.trim() || process.env.PI_CONFIG_DIR?.trim() || ".gjc";
const defaultAgentDir = path.join(os.homedir(), configDirName, "agent");
const resolvesToDefaultAgentDir = (dir: string): boolean => {
	const resolved = path.resolve(dir);
	if (resolved === defaultAgentDir) return true;
	try {
		return fs.realpathSync(resolved) === fs.realpathSync(defaultAgentDir);
	} catch {
		return false;
	}
};
if (!configuredAgentDir || resolvesToDefaultAgentDir(configuredAgentDir)) {
	try {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-test-agent-"));
		process.env.GJC_CODING_AGENT_DIR = agentDir;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	} catch {
		// Leave the environment untouched if the temp root cannot be created;
		// the suite then runs against the operator's real agent dir as before.
	}
}
