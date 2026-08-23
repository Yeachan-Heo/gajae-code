import { installRuntimeDeletionGuard } from "./safe-cleanup";
import { decideAgentDirIsolation, readProjectEnvFile, stripAmbientProviderEnvironment } from "./test-agent-dir-isolation";
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

// Hermetic unit shards must not discover the operator's provider credentials or
// proxy endpoints. Explicitly opted-in E2E runs are different: their tests use
// E2E=1 as the credential gate, so scrubbing the same variables here would make
// them silently skip instead of exercising the live provider path. E2E callers
// own that opt-in and must provide their credentials explicitly.
const e2eEnabled = /^(1|true|yes|on)$/i.test(process.env.E2E?.trim() ?? "");
if (!e2eEnabled) stripAmbientProviderEnvironment(process.env);

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
//
// Recursive-deletion boundary (issue #4794). An operator's real home was
// destroyed by test cleanup activity; this preload now installs a
// fail-closed runtime guard over the deletion surfaces Bun 1.4.0 allows
// intercepting (`fs.promises.rm/rmdir` — shared by reference across every
// import style — plus the CJS `require("node:fs")` exports). ESM top-level
// `fs.rmSync` bindings are immutable snapshots in Bun and cannot be patched;
// repository test source is covered instead by `scripts/check-unsafe-rmrf.ts`
// (run in `check:tools`), and the interception matrix is pinned by
// scripts/safe-cleanup-guard.test.ts. The safe world captures the REAL home at
// module-load time — before any test mutates process.env.HOME — so a cleanup
// bug that resolves back to the operator home aborts this process instead of
// deleting it. A refusal exits 70 by default.
installRuntimeDeletionGuard({ label: "test-preload" });
