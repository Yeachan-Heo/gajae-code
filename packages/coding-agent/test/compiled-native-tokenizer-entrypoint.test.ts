import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const devBuildScriptPath = path.join(repoRoot, "packages/coding-agent/scripts/build-binary.ts");
const compileArgsPath = path.join(repoRoot, "packages/coding-agent/scripts/compile-args.ts");

describe("compiled binary entrypoints", () => {
	it("dev binary build omits native tokenizer entrypoint while preserving minify and worker entrypoints", async () => {
		const devSource = await Bun.file(devBuildScriptPath).text();
		const argsSource = await Bun.file(compileArgsPath).text();

		// Dev entrypoints (shared builder) must not include the native
		// tokenizer entry — that one is release-only.
		expect(devSource).not.toContain("nativeTokenizerEntrypoint");
		expect(argsSource).not.toContain('"../natives/native/index.js"');
		// Shared builder carries --minify and the dev worker entrypoints
		// consumed by build-binary.ts via buildDevCompileArgs. handlebars must
		// NOT be an extra entrypoint (#1939: --minify silently dropped it).
		expect(argsSource).toContain('"--minify"');
		expect(argsSource).not.toContain('"../../node_modules/handlebars/lib/index.js"');
		expect(argsSource).toContain('"../stats/src/sync-worker.ts"');
		expect(argsSource).toContain('"./src/tools/browser/tab-worker-entry.ts"');
		expect(argsSource).toContain('"./src/eval/js/worker-entry.ts"');
		expect(devSource).toContain("buildDevCompileArgs");
	});
});
