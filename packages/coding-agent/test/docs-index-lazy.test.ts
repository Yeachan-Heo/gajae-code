import { describe, expect, it } from "bun:test";

function runBunEval(script: string) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "-e", script],
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	expect(result.exitCode, stderr || stdout).toBe(0);
	return stdout;
}

describe("internal-urls docs index loading", () => {
	it("does not load the generated docs corpus when importing the barrel", () => {
		const stdout = runBunEval(`
			await import("@gajae-code/coding-agent/internal-urls");
			const loaded = Object.keys(require.cache).some(path => path.includes("docs-index.generated"));
			console.log(JSON.stringify({ loaded }));
		`);
		const result = JSON.parse(stdout.trim()) as { loaded: boolean };

		expect(result.loaded).toBe(false);
	});

	it("loads the generated docs corpus when resolving gjc docs", () => {
		const stdout = runBunEval(`
			const { InternalUrlRouter } = await import("@gajae-code/coding-agent/internal-urls");
			const resource = await InternalUrlRouter.instance().resolve("gjc://");
			const loaded = Object.keys(require.cache).some(path => path.includes("docs-index.generated"));
			console.log(JSON.stringify({
				loaded,
				contentType: resource.contentType,
				contentLength: resource.content.length,
			}));
		`);
		const result = JSON.parse(stdout.trim()) as { loaded: boolean; contentType: string; contentLength: number };

		expect(result.loaded).toBe(true);
		expect(result.contentType).toBe("text/markdown");
		expect(result.contentLength).toBeGreaterThan(0);
	});
});
