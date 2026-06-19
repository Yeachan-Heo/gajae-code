import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const devBuildScriptPath = path.join(repoRoot, "packages/coding-agent/scripts/build-binary.ts");

describe("compiled binary entrypoints", () => {
	it("dev binary build omits native tokenizer entrypoint while preserving minify and worker entrypoints", async () => {
		const source = await Bun.file(devBuildScriptPath).text();

		expect(source).not.toContain("nativeTokenizerEntrypoint");
		expect(source).toContain('"--minify"');
		expect(source).toContain('"../stats/src/sync-worker.ts"');
		expect(source).toContain('"./src/tools/browser/tab-worker-entry.ts"');
		expect(source).toContain('"./src/eval/js/worker-entry.ts"');
	});
});
