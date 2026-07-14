import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { EMBEDDED_DOCS } from "../src/internal-urls/docs-index.generated";

function runBunEval(script: string) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "-e", script],
		cwd: path.join(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	expect(result.exitCode, stderr || stdout).toBe(0);
	return stdout;
}

const DOCS_WITH_SOURCE_PARITY = ["gpt-5.6-codex-preset-benchmark.md", "models.md"] as const;

describe("internal-urls docs index loading", () => {
	it("does not load the generated docs corpus when importing the barrel", () => {
		const stdout = runBunEval(`
			const marker = Symbol.for("gjc.docs-index.generated.loaded");
			Reflect.deleteProperty(globalThis, marker);
			await import("@gajae-code/coding-agent/internal-urls");
			const loaded = Reflect.get(globalThis, marker) === true;
			console.log(JSON.stringify({ loaded }));
		`);
		const result = JSON.parse(stdout.trim()) as { loaded: boolean };

		expect(result.loaded).toBe(false);
	});

	it("loads the generated docs corpus when resolving gjc docs", () => {
		const stdout = runBunEval(`
			const { InternalUrlRouter } = await import("@gajae-code/coding-agent/internal-urls");
			const resource = await InternalUrlRouter.instance().resolve("gjc://");
			console.log(JSON.stringify({
				contentType: resource.contentType,
				contentLength: resource.content.length,
			}));
		`);
		const result = JSON.parse(stdout.trim()) as { contentType: string; contentLength: number };
		expect(result.contentType).toBe("text/markdown");
		expect(result.contentLength).toBeGreaterThan(0);
	});

	it.each([...DOCS_WITH_SOURCE_PARITY])("matches the source %s document", async fileName => {
		const source = await Bun.file(path.join(import.meta.dir, "../../../docs", fileName)).text();

		expect(EMBEDDED_DOCS[fileName]).toBe(source);
	});
});
