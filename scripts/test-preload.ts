import * as fs from "node:fs";
import * as os from "node:os";

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

// The session-context materialization budget defaults to 512 MiB in production
// (overridable via GJC_SESSION_CONTEXT_BUDGET_BYTES). Test fixtures in
// session-context-overflow.test.ts were authored against the former 64 MiB
// default (BIG_TEXT = 40 MiB → ~80 MiB measured). Pin the budget to 64 MiB for
// the test process so those fixtures keep triggering the overflow preflight
// without inflating memory usage across every other test suite.
//
// bun test runs every test file in a single shared process, so a per-file env
// override would leak across files and make the 512 MiB production default
// nondeterministic. The production default itself is exercised deterministically
// by session-context-budget.test.ts, which spawns a clean subprocess (no
// GJC_SESSION_CONTEXT_BUDGET_BYTES in the environment) and asserts the resolved
// budget equals 512 MiB — so the test pin here cannot drift from production
// semantics silently.
process.env.GJC_SESSION_CONTEXT_BUDGET_BYTES = String(64 * 1024 * 1024);
