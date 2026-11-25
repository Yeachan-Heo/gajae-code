/**
 * The strict seam is turned on only through `useStrictWriteDetection` (strict-write-detection.ts),
 * whose afterEach checks each test's counter delta, so a strict throw a caller swallows still fails
 * the test. A test that set the seam directly would lose that check.
 *
 * Every TypeScript file under the package's `test/` is scanned. Any mention of the seam's name
 * other than in a `delete` counts: an assignment, bracket access, `Object.assign` or a spread all
 * name it.
 */
import { expect, it } from "bun:test";
import * as path from "node:path";

const SEAM = "strictWriteDetection";

/** Files that may mention the seam other than to delete it, and exactly how often. */
const ALLOWED: Record<string, { readonly mentions: number | "any"; readonly reason: string }> = {
	"session/strict-write-detection.ts": { mentions: "any", reason: "the helper itself" },
	"session/strict-seam-usage.test.ts": { mentions: "any", reason: "this guard" },
	"session/session-claim-set.test.ts": { mentions: 1, reason: "unit test of the seam: checkWrite throws under it" },
};

/** Mentions of the seam's name, not counting `delete <expression>.strictWriteDetection`. */
function mentions(text: string): number {
	const all = text.split(SEAM).length - 1;
	const deletions = text.match(/\bdelete\s+[\w$.]+\.strictWriteDetection\b/g)?.length ?? 0;
	return all - deletions;
}

it("only the strict-seam helper turns the strict seam on", async () => {
	const root = path.join(import.meta.dir, "..");
	const found: Record<string, number> = {};
	for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
		const count = mentions(await Bun.file(path.join(root, file)).text());
		const allowed = ALLOWED[file];
		if (allowed?.mentions === "any") continue;
		if (count !== (allowed?.mentions ?? 0)) found[file] = count;
	}
	expect(found).toEqual({});
});
