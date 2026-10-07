// Issue #4794 e2e fixture: the account-home probe must resolve the real home
// from inside this repository's preloaded `bun test` posture, and that
// resolution is what authorizes the standard temp roots.
//
// Run only via scripts/safe-cleanup-guard.test.ts, which invokes it with a BARE
// RELATIVE path on purpose. Bun 1.4.0 only reproduces the piped-spawn `EBADF`
// defect for that path shape; an absolute path silently gives the child a
// working pipe and hides the very regression this fixture exists to catch.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultSafeCleanupWorld } from "../safe-cleanup";

test("the default world resolves the real account home", () => {
	const world = getDefaultSafeCleanupWorld();

	if (world.homeAliases.length > 0) process.stderr.write("homeAliases>0\n");

	// A standard temp root is only authorized once the home is known: with an
	// empty home alias the world collapses to the repository root alone.
	const tempRoot = fs.realpathSync(os.tmpdir());
	if (world.allowedRoots.some((root) => path.resolve(root) === tempRoot)) {
		process.stderr.write("tempRootAuthorized\n");
	}

	expect(world.homeAliases.length).toBeGreaterThan(0);
	for (const home of world.homeAliases) expect(path.isAbsolute(home)).toBe(true);
	expect(world.allowedRoots.length).toBeGreaterThan(1);
});
