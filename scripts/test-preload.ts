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

