import { projectEnvSnapshot } from "../packages/utils/src/env-file";
import { installRuntimeDeletionGuard } from "./safe-cleanup";
import { decideAgentDirIsolation, stripAmbientProviderEnvironment } from "./test-agent-dir-isolation";
import { decideLogDirIsolation } from "./test-log-dir-isolation";
import { formatWorkspaceDependencyFailure, inspectWorkspaceDependencies } from "./worktree-deps";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Fail fast in a fresh `git worktree add` checkout (issue #5484). Without
// installed workspace dependencies every test file dies on a bare
// `Cannot find module '@gajae-code/...'` error that names neither the cause nor
// the fix. This runs before any test import and before the isolation guards
// below, because there is nothing to isolate when the suite cannot even start.
const workspaceDependencies = inspectWorkspaceDependencies({ repoRoot: path.join(import.meta.dir, "..") });
if (workspaceDependencies.status !== "ready") {
	throw new Error(formatWorkspaceDependencyFailure(workspaceDependencies));
}

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

// The checkout's dotenv declarations, resolved ONCE through the same layered
// snapshot production uses (`.env`, `.env.$NODE_ENV`, `.env.local` — skipped
// under NODE_ENV=test — and `.env.$NODE_ENV.local`). Both isolation decisions
// below read it.
//
// The agent-dir call site previously had the identical narrowness the log-dir
// one did (a bespoke `cwd/.env`-only reader), and leaving two different notions
// of provenance in one preload is the same defect relocated. Widening it can
// only move cases from `honor` to `isolate`, which is the fail-safe direction,
// and the repository ships no dotenv files at its root, so no CI or dev-machine
// behaviour changes.
const projectEnv = projectEnvSnapshot(process.cwd());

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
	projectEnv: projectEnv.values,
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

// Isolate the log sink for every test process (issue #5618). The agent-dir
// isolation above does not cover logging: `getLogsDir()` resolves
// `rootSubdir("logs", "state")` — the REAL config root — so fixtures that drive
// production code paths append genuine `level:error` records to the operator's
// shared `~/.gjc/logs/gjc.<date>.log`. In a measured 24h window 90% of the error
// records in that sink were ACP prompt-watchdog fixture output, which makes the
// operator's own log useless for diagnosing real failures.
//
// Setting this on `process.env` also reaches spawned child fixtures, which is
// intended: they inherit the same isolated sink.
//
// A caller that pinned GJC_LOG_DIR explicitly means it (e.g. a fixture asserting
// on log content), so that is honored untouched — but only when the pin is
// trusted. A nonblank value is not evidence of intent on its own: Bun overlays
// `cwd/.env` into `process.env` before any module runs, so a checkout that
// declares GJC_LOG_DIR would otherwise be honored here and isolation would never
// happen. The decision (including that distrust rule) lives in
// ./test-log-dir-isolation.ts so it is unit-testable without importing this
// preload's side effects.
//
// FAIL CLOSED, as with the agent dir: if the temp sink cannot be created — or if
// the checkout declares GJC_LOG_DIR dynamically, where no pin this preload sets
// can survive production's provenance check — throw. Continuing would silently
// run the suite against the operator's live log sink, which is the regression
// this exists to prevent.
const logIsolation = decideLogDirIsolation({
	env: { GJC_LOG_DIR: process.env.GJC_LOG_DIR },
	projectEnv,
});
if (logIsolation.action === "fail") {
	throw new Error(
		"Test log-directory isolation failed (dynamic): this checkout's .env declares GJC_LOG_DIR with a `$` or " +
			"backtick in its value. Bun expands it at load time, so the trust check in packages/utils/src/dirs.ts " +
			"rejects the key entirely and log writes would fall back to the operator's live log sink no matter what " +
			"this preload pins. Remove GJC_LOG_DIR from the project .env before running tests.",
	);
}
if (logIsolation.action === "isolate") {
	try {
		process.env.GJC_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-test-logs-"));
	} catch (error) {
		throw new Error(
			`Test log-directory isolation failed (${logIsolation.reason}); refusing to run tests against the live log sink: ${String(error)}`,
		);
	}
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
