// Issue #4794 e2e fixture: attempts a recursive force removal of a directory
// OUTSIDE the allowed roots. Run only via scripts/safe-cleanup-guard.test.ts,
// which creates the probe directory under /var/tmp first. The test preload's
// deletion guard must abort this process (exit 70) before anything is deleted.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const probe = process.env.GJC_GUARD_PROBE_DIR;
test("guard aborts out-of-root recursive removal", async () => {
	if (!probe) throw new Error("GJC_GUARD_PROBE_DIR is required");
	// fs.promises.rm is an interceptable surface (shared promises object).
	await fs.promises.rm(path.join(probe), { recursive: true, force: true });
	expect(fs.existsSync(probe)).toBe(false); // must never be reached
});
