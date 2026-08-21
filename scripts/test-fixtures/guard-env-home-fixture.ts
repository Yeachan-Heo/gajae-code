// Issue #4794 e2e fixture: the parent sets HOME to a fake home it owns under
// the OS temp root and points GJC_GUARD_PROBE_DIR at it. The child test
// process inherits that HOME, so its preload captures it as the real-home
// alias, and a recursive removal of it must be refused with `real-home` even
// though it is inside the allowed temp root. The operator's actual HOME is
// never involved. Run only via scripts/safe-cleanup-guard.test.ts.
import { expect, test } from "bun:test";
import * as fs from "node:fs";

const probe = process.env.GJC_GUARD_PROBE_DIR;
test("guard refuses the home captured at preload time", async () => {
	if (!probe) throw new Error("GJC_GUARD_PROBE_DIR is required");
	await fs.promises.rm(probe, { recursive: true, force: true });
	expect(fs.existsSync(probe)).toBe(false); // must never be reached
});
