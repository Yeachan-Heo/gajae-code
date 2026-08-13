import { decideAgentDirIsolation, readProjectEnvFile } from "./test-agent-dir-isolation";
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
// The decision (including the project-`.env` distrust rule production applies)
// lives in ./test-agent-dir-isolation.ts so it is unit-testable without
// importing this preload's side effects.
//
// FAIL CLOSED: if the isolated directory cannot be created, throw. Continuing
// would silently run the suite against the operator's live agent dir, which is
// the exact destructive regression this preload exists to prevent.
const isolation = decideAgentDirIsolation({
	home: os.homedir(),
	env: {
		GJC_CODING_AGENT_DIR: process.env.GJC_CODING_AGENT_DIR,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		GJC_CONFIG_DIR: process.env.GJC_CONFIG_DIR,
		PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
	},
	projectEnv: readProjectEnvFile(process.cwd()),
});
if (isolation.action === "isolate") {
	let agentDir: string;
	try {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-test-agent-"));
	} catch (error) {
		throw new Error(
			`Test agent-directory isolation failed (${isolation.reason}); refusing to run tests against the live agent dir: ${String(error)}`,
		);
	}
	process.env.GJC_CODING_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
}
