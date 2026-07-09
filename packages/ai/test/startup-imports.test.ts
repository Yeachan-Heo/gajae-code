import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

function runIsolationScript(script: string): unknown {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "-e", script],
		cwd: path.resolve(import.meta.dir, "../../.."),
		env: {
			HOME: Bun.env.HOME ?? "",
			PATH: Bun.env.PATH ?? "",
		},
		stderr: "pipe",
		stdout: "pipe",
	});
	const stdout = new TextDecoder().decode(result.stdout).trim();
	const stderr = new TextDecoder().decode(result.stderr).trim();
	if (result.exitCode !== 0) {
		throw new Error([stdout, stderr].filter(Boolean).join("\n") || `isolation script exited with ${result.exitCode}`);
	}
	return JSON.parse(stdout);
}

describe("AI package startup imports", () => {
	it("does not parse the bundled model catalog when importing the barrel", () => {
		const indexUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/index.ts")).href;
		const modelsJsonPath = path.resolve(import.meta.dir, "../src/models.json");
		const result = runIsolationScript(`
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(indexUrl)});
const modelsJsonPath = require.resolve(${JSON.stringify(modelsJsonPath)});
await import(${JSON.stringify(indexUrl)});
console.log(JSON.stringify({ catalogLoaded: Boolean(require.cache[modelsJsonPath]) }));
`);

		expect(result).toEqual({ catalogLoaded: false });
	});
});
