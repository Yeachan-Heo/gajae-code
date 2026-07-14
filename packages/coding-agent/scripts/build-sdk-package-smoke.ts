#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");
const packageName = "@gajae-code/coding-agent";
const aiPackageDir = path.resolve(packageDir, "../ai");
const bridgeClientPackageDir = path.resolve(packageDir, "../bridge-client");
const manifestsDir = path.join(packageDir, "test/manifests");
const baselinePath = path.join(manifestsDir, "sdk-public-surface-v1.json");
const generatedPath = path.join(manifestsDir, "sdk-public-surface.generated.json");

type Surface = { root: string[]; sdk: string[] };

function run(command: string[], cwd: string): string {
	const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")} failed:\n${new TextDecoder().decode(result.stderr)}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

function assertExport(module: Record<string, unknown>, name: string, subpath: string): void {
	if (!(name in module)) throw new Error(`${subpath} does not export ${name}`);
}

async function runSmoke(): Promise<Surface> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-package-smoke-"));
	try {
		const aiTarball = run(["bun", "pm", "pack", "--destination", tempDir, "--quiet"], aiPackageDir);
		const bridgeClientTarball = run(
			["bun", "pm", "pack", "--destination", tempDir, "--quiet"],
			bridgeClientPackageDir,
		);
		const codingAgentTarball = run(["bun", "pm", "pack", "--destination", tempDir, "--quiet"], packageDir);
		const aiTarballPath = path.isAbsolute(aiTarball) ? aiTarball : path.join(aiPackageDir, aiTarball);
		const bridgeClientTarballPath = path.isAbsolute(bridgeClientTarball)
			? bridgeClientTarball
			: path.join(bridgeClientPackageDir, bridgeClientTarball);
		const codingAgentTarballPath = path.isAbsolute(codingAgentTarball)
			? codingAgentTarball
			: path.join(packageDir, codingAgentTarball);
		await fs.writeFile(
			path.join(tempDir, "package.json"),
			JSON.stringify(
				{
					name: "sdk-smoke",
					private: true,
					dependencies: {
						"@gajae-code/ai": `file:${aiTarballPath}`,
						"@gajae-code/bridge-client": `file:${bridgeClientTarballPath}`,
						[packageName]: `file:${codingAgentTarballPath}`,
					},
					overrides: {
						"@gajae-code/ai": `file:${aiTarballPath}`,
						"@gajae-code/bridge-client": `file:${bridgeClientTarballPath}`,
					},
				},
				null,
				2,
			),
		);
		// Install the matching packed workspace artifacts so the smoke test exercises the
		// release dependency boundary without falling back to an older registry package.
		run(["bun", "install", "--ignore-scripts"], tempDir);
		const probePath = path.join(tempDir, "probe.ts");
		await fs.writeFile(
			probePath,
			`import * as root from ${JSON.stringify(packageName)};\nimport * as sdk from ${JSON.stringify(`${packageName}/sdk`)};\nimport * as bus from ${JSON.stringify(`${packageName}/sdk/bus`)};\nimport * as bridgeClient from "@gajae-code/bridge-client";\nconst required = [[root, "createAgentSession", "root"], [sdk, "createAgentSession", "sdk"], [bus, "createNotificationsExtension", "sdk/bus"], [sdk, "SdkClient", "sdk"], [bridgeClient, "SdkClient", "bridge-client"]] as const;\nfor (const [module, name, subpath] of required) if (!(name in module)) throw new Error(subpath + " missing " + name);\nif (sdk.SdkClient !== bridgeClient.SdkClient) throw new Error("SdkClient class identity differs between sdk and bridge-client");\nprocess.stdout.write(JSON.stringify({ root: Object.keys(root).sort(), sdk: Object.keys(sdk).sort() }));\n`,
		);
		const surface = JSON.parse(run(["bun", "run", probePath], tempDir)) as Surface;
		assertExport(Object.fromEntries(surface.root.map(name => [name, true])), "createAgentSession", "root");
		assertExport(Object.fromEntries(surface.sdk.map(name => [name, true])), "SdkClient", "sdk");
		return { root: [...surface.root].sort(), sdk: [...surface.sdk].sort() };
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const surface = await runSmoke();
	await fs.mkdir(manifestsDir, { recursive: true });
	await fs.writeFile(generatedPath, `${JSON.stringify(surface, null, 2)}\n`);
	const baseline = JSON.parse(await Bun.file(baselinePath).text()) as Surface;
	const removals = (Object.keys(baseline) as Array<keyof Surface>).flatMap(area =>
		baseline[area].filter(name => !surface[area].includes(name)).map(name => `${area}.${name}`),
	);
	if (removals.length > 0) throw new Error(`SDK public surface removals are not allowed:\n${removals.join("\n")}`);
	process.stdout.write(`SDK package smoke passed (root: ${surface.root.length}, sdk: ${surface.sdk.length}).\n`);
}

await main();
