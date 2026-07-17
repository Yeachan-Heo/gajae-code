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
		// The catalog is embedded via `import ... with { type: "file" }` and parsed
		// lazily with fs.readFileSync, so the startup contract is observable as
		// "importing the barrel performs no filesystem read of models.json"
		// (module-cache presence no longer discriminates, because the file-type
		// import registers the path eagerly without parsing).
		const result = runIsolationScript(`
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(indexUrl)});
const fs = require("node:fs");
const realReadFileSync = fs.readFileSync;
let catalogReads = 0;
fs.readFileSync = function (file, ...args) {
	if (String(file).endsWith("models.json")) catalogReads += 1;
	return realReadFileSync.call(this, file, ...args);
};
await import(${JSON.stringify(indexUrl)});
console.log(JSON.stringify({ catalogLoaded: catalogReads > 0 }));
`);

		expect(result).toEqual({ catalogLoaded: false });
	});
});
