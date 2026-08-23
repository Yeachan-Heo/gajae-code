// Issue #4794 e2e fixture: the parent sets HOME to a fake home it owns under
// the OS temp root and points GJC_GUARD_PROBE_DIR at it. The child test
// process must resolve the real account home independently, so this owned
// temp fixture remains a permitted cleanup target. Run only via
// scripts/safe-cleanup-guard.test.ts.
import { expect, test } from "bun:test";
import * as fs from "node:fs";

const probe = process.env.GJC_GUARD_PROBE_DIR;
test("guard uses the independent account home instead of ambient HOME", async () => {
	if (!probe) throw new Error("GJC_GUARD_PROBE_DIR is required");
	await fs.promises.rm(probe, { recursive: true, force: true });
	expect(fs.existsSync(probe)).toBe(false); // must never be reached
});
