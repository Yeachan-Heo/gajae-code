import { describe, expect, it } from "bun:test";

import * as path from "node:path";

import { buildDevCompileArgs, buildReleaseCompileArgs, releaseEntrypoints } from "../scripts/compile-args";

const releaseArgs = buildReleaseCompileArgs("bun-darwin-arm64", "packages/coding-agent/binaries/gjc-darwin-arm64");

function valuesAfter(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] === flag) {
			values.push(args[index + 1]);
		}
	}
	return values;
}

describe("release build compile args", () => {
	it("keeps minify and names flags in the release config", () => {
		expect(releaseArgs).toContain("--minify");
		expect(releaseArgs).toContain("--keep-names");
	});

	it("minifies both dev and release builds", () => {
		expect(buildDevCompileArgs()).toContain("--minify");
		expect(releaseArgs).toContain("--minify");
	});

	it("includes worker and lazy CommonJS entrypoints in release args", () => {
		expect(releaseEntrypoints).toContain("./packages/stats/src/sync-worker.ts");
		expect(releaseEntrypoints).toContain("./packages/coding-agent/src/tools/browser/tab-worker-entry.ts");
		expect(releaseEntrypoints).toContain("./packages/coding-agent/src/eval/js/worker-entry.ts");
		expect(releaseEntrypoints).toContain("./packages/ai/src/models.json");
		expect(releaseEntrypoints).toContain("./node_modules/handlebars/lib/index.js");
		expect(releaseArgs).toContain("./packages/stats/src/sync-worker.ts");
		expect(releaseArgs).toContain("./packages/coding-agent/src/tools/browser/tab-worker-entry.ts");
		expect(releaseArgs).toContain("./packages/coding-agent/src/eval/js/worker-entry.ts");
		expect(releaseArgs).toContain("./packages/ai/src/models.json");
		expect(releaseArgs).toContain("./node_modules/handlebars/lib/index.js");
	});

	it("includes lazy CommonJS entrypoints in dev args", () => {
		expect(buildDevCompileArgs()).toContain("../ai/src/models.json");
		expect(buildDevCompileArgs()).toContain("../../node_modules/handlebars/lib/index.js");
	});

	it("has exactly one target and outfile", () => {
		expect(valuesAfter(releaseArgs, "--target")).toEqual(["bun-darwin-arm64"]);
		expect(valuesAfter(releaseArgs, "--outfile")).toEqual(["packages/coding-agent/binaries/gjc-darwin-arm64"]);
	});

	it("release script dry-run executes the builder output unmodified", () => {
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const result = Bun.spawnSync({
			cmd: [process.execPath, "scripts/ci-release-build-binaries.ts", "--dry-run"],
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = result.stdout.toString();
		expect(result.exitCode, result.stderr.toString() || stdout).toBe(0);

		const buildLines = stdout.split("\n").filter(line => line.includes("bun build --compile"));
		expect(buildLines.length).toBeGreaterThan(0);
		for (const line of buildLines) {
			const target = valuesAfter(line.replace(/^DRY RUN /, "").split(" "), "--target")[0];
			const outfile = valuesAfter(line.replace(/^DRY RUN /, "").split(" "), "--outfile")[0];
			expect(target).toBeDefined();
			expect(outfile).toBeDefined();
			expect(line).toBe(`DRY RUN ${buildReleaseCompileArgs(target as string, outfile as string).join(" ")}`);
		}
	});
});
