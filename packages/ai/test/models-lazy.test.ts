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
	it("enumerates without parsing bodies and reads only the requested provider shard once", () => {
		const modelsUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/models.ts")).href;
		const modelsJsonPath = path.resolve(import.meta.dir, "../src/models.json");
		const openAIShardPath = path.resolve(import.meta.dir, "../src/model-shards/openai.json");
		const result = runIsolationScript(`
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(modelsUrl)});
const fs = require("node:fs");
const realReadFileSync = fs.readFileSync;
const bodyReads = [];
fs.readFileSync = function (file, ...args) {
	const fileName = String(file);
	if (fileName.includes("/model-shards/") || fileName.endsWith("/models.json")) {
		bodyReads.push(fileName);
	}
	return realReadFileSync.call(this, file, ...args);
};
const modelsModule = await import(${JSON.stringify(modelsUrl)});
const readsAfterImport = bodyReads.length;
const providers = modelsModule.getBundledProviders();
const readsAfterEnumeration = bodyReads.length;
const model = modelsModule.getBundledModel("openai", "gpt-4o-mini");
const readsAfterLookup = bodyReads.length;
modelsModule.getBundledModel("openai", "gpt-4o-mini");
modelsModule.getBundledModels("openai");
const readsAfterRepeat = bodyReads.length;
const directCatalog = JSON.parse(realReadFileSync(${JSON.stringify(modelsJsonPath)}, "utf8"));
console.log(JSON.stringify({
	readsAfterImport,
	readsAfterEnumeration,
	readsAfterLookup,
	readsAfterRepeat,
	bodyReads,
	providers,
	directProviders: Object.keys(directCatalog),
	model,
	directModel: directCatalog.openai["gpt-4o-mini"],
	fullCatalogBytes: fs.statSync(${JSON.stringify(modelsJsonPath)}).size,
	shardBytes: fs.statSync(${JSON.stringify(openAIShardPath)}).size,
}));
`);

		expect(result).toMatchObject({
			readsAfterImport: 0,
			readsAfterEnumeration: 0,
			readsAfterLookup: 1,
			readsAfterRepeat: 1,
			bodyReads: [openAIShardPath],
		});
		const measured = result as {
			providers: string[];
			directProviders: string[];
			model: unknown;
			directModel: unknown;
			fullCatalogBytes: number;
			shardBytes: number;
		};
		expect(measured.providers).toEqual(measured.directProviders);
		expect(measured.model).toEqual(measured.directModel);
		expect(measured.shardBytes).toBeLessThan(measured.fullCatalogBytes * 0.4);
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
