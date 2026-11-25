/**
 * The strict seam is turned on only through `useStrictWriteDetection` (strict-write-detection.ts),
 * whose afterEach checks each test's counter delta, so a strict throw a caller swallows still fails
 * the test. A test that set the seam directly would lose that check.
 *
 * Scanned: every `.ts`, `.tsx`, `.js`, `.mts` and `.cts` file under the package's `test/`, and the
 * `*.test.ts(x)` files colocated under `src/`. Comments are removed first (by transpiling), and
 * then every remaining occurrence of the seam's name counts, except as the target of a `delete`:
 * an assignment of any kind (`=`, `??=`, `||=`), bracket access, `Object.assign`, `Reflect.set`,
 * a spread or a string all name it.
 */
import { expect, it } from "bun:test";
import * as path from "node:path";

const SEAM = "strictWriteDetection";

/** Files that may mention the seam other than to delete it, and exactly how often. */
const ALLOWED: Record<string, { readonly mentions: number | "any"; readonly reason: string }> = {
	"test/session/strict-write-detection.ts": { mentions: "any", reason: "the helper itself" },
	"test/session/strict-seam-usage.test.ts": { mentions: "any", reason: "this guard" },
	"test/session/session-claim-set.test.ts": {
		mentions: 1,
		reason: "unit test of the seam: checkWrite throws under it",
	},
};

const LOADERS = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js" } as const;

/** Mentions of the seam's name outside comments, not counting the target of a `delete`. */
function seamMentions(file: string, text: string): number {
	const loader = LOADERS[path.extname(file) as keyof typeof LOADERS] ?? "ts";
	const code = new Bun.Transpiler({ loader, deadCodeElimination: false }).transformSync(text);
	const all = code.split(SEAM).length - 1;
	const deletions =
		code.match(/\bdelete\s+[\w$.]+(?:\.strictWriteDetection\b|\[\s*["'`]strictWriteDetection["'`]\s*\])/g)?.length ??
		0;
	return all - deletions;
}

it("only the strict-seam helper turns the strict seam on", async () => {
	const root = path.join(import.meta.dir, "..", "..");
	const scans = [
		{ cwd: path.join(root, "test"), prefix: "test", pattern: "**/*.{ts,tsx,js,mts,cts}" },
		{ cwd: path.join(root, "src"), prefix: "src", pattern: "**/*.test.{ts,tsx}" },
	];
	const found: Record<string, number> = {};
	for (const { cwd, prefix, pattern } of scans) {
		for await (const relative of new Bun.Glob(pattern).scan({ cwd })) {
			const file = `${prefix}/${relative}`;
			const text = await Bun.file(path.join(cwd, relative)).text();
			if (!text.includes(SEAM)) continue;
			const allowed = ALLOWED[file];
			if (allowed?.mentions === "any") continue;
			const count = seamMentions(file, text);
			if (count !== (allowed?.mentions ?? 0)) found[file] = count;
		}
	}
	expect(found).toEqual({});
});
