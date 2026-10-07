import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHelpers } from "../src/eval/js/shared/helpers";

test("eval diff helper formats native hunks as a two-file patch", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-eval-diff-"));
	try {
		const fileA = path.join(cwd, "old.txt");
		const fileB = path.join(cwd, "new.txt");
		await fs.writeFile(fileA, "first\nold\nlast\n");
		await fs.writeFile(fileB, "first\nnew\nlast\n");
		const statusEvents: object[] = [];
		const helpers = createHelpers({ cwd: () => cwd, env: new Map(), emitStatus: event => statusEvents.push(event) });

		const result = await helpers.diff("old.txt", "new.txt");
		expect(result).toBe(
			`${[
				"===================================================================",
				`--- ${fileA}`,
				`+++ ${fileB}`,
				"@@ -1,3 +1,3 @@",
				" first",
				"-old",
				"+new",
				" last",
			].join("\n")}\n`,
		);
		expect(statusEvents).toHaveLength(1);
		const sameFilePatch = await helpers.diff("old.txt", "old.txt");
		expect(sameFilePatch).toBe(
			`Index: ${fileA}\n===================================================================\n--- ${fileA}\n+++ ${fileA}\n`,
		);
		expect(statusEvents).toHaveLength(2);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
