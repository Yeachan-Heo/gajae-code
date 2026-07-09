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

describe("bundled models catalog lazy loading", () => {
	it("does not read models.json until the first synchronous accessor call", () => {
		const modelsUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/models.ts")).href;
		const modelsJsonPath = path.resolve(import.meta.dir, "../src/models.json");
		// The catalog is embedded via `import ... with { type: "file" }` and read
		// lazily with fs.readFileSync. The lazy contract is therefore observable as
		// "no filesystem read of models.json at import time; exactly one read on
		// first accessor use" (module-cache presence no longer discriminates,
		// because the file-type import registers the path eagerly without parsing).
		const result = runIsolationScript(`
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(modelsUrl)});
const fs = require("node:fs");
const realReadFileSync = fs.readFileSync;
let catalogReads = 0;
fs.readFileSync = function (file, ...args) {
	if (String(file).endsWith("models.json")) catalogReads += 1;
	return realReadFileSync.call(this, file, ...args);
};
const modelsModule = await import(${JSON.stringify(modelsUrl)});
const before = catalogReads > 0;
const directCatalog = JSON.parse(realReadFileSync(${JSON.stringify(modelsJsonPath)}, "utf8"));
const providers = modelsModule.getBundledProviders();
const model = modelsModule.getBundledModel("openai", "gpt-4o-mini");
const after = catalogReads > 0;
modelsModule.getBundledProviders();
console.log(JSON.stringify({
	before,
	after,
	catalogReads,
	providers,
	directProviders: Object.keys(directCatalog),
	model,
	directModel: directCatalog.openai["gpt-4o-mini"],
}));
`);

		expect(result).toMatchObject({ before: false, after: true, catalogReads: 1 });
		expect((result as { providers: string[]; directProviders: string[] }).providers).toEqual(
			(result as { providers: string[]; directProviders: string[] }).directProviders,
		);
		expect((result as { model: unknown; directModel: unknown }).model).toEqual(
			(result as { model: unknown; directModel: unknown }).directModel,
		);
	});

	it("keeps public accessors synchronous", () => {
		const modelsUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/models.ts")).href;
		const result = runIsolationScript(`
const modelsModule = await import(${JSON.stringify(modelsUrl)});
const providers = modelsModule.getBundledProviders();
const model = modelsModule.getBundledModel("openai", "gpt-4o-mini");
console.log(JSON.stringify({
	providersIsArray: Array.isArray(providers),
	modelId: model.id,
	providersThen: typeof providers?.then,
	modelThen: typeof model?.then,
}));
`);

		expect(result).toEqual({
			providersIsArray: true,
			modelId: "gpt-4o-mini",
			providersThen: "undefined",
			modelThen: "undefined",
		});
	});
});
