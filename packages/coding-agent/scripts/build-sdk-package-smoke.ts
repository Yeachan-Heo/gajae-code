#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");
const packageName = "@gajae-code/coding-agent";
const aiPackageDir = path.resolve(packageDir, "../ai");
const bridgeClientPackageDir = path.resolve(packageDir, "../bridge-client");
const tuiPackageDir = path.resolve(packageDir, "../tui");
const nativesPackageDir = path.resolve(packageDir, "../natives");
const linuxX64PackageDir = path.resolve(packageDir, "../natives-linux-x64");
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
		const stagedLinuxX64Dir = path.join(tempDir, "natives-linux-x64");
		await fs.cp(linuxX64PackageDir, stagedLinuxX64Dir, { recursive: true });
		const stagedNativeDir = path.join(stagedLinuxX64Dir, "native");
		await fs.mkdir(stagedNativeDir, { recursive: true });
		for (const entry of await fs.readdir(path.join(nativesPackageDir, "native"))) {
			if (entry.startsWith("pi_natives.linux-x64") && entry.endsWith(".node")) {
				await fs.copyFile(path.join(nativesPackageDir, "native", entry), path.join(stagedNativeDir, entry));
			}
		}
		const aiTarball = run(["bun", "pm", "pack", "--destination", tempDir, "--quiet"], aiPackageDir);
		const bridgeClientTarball = run(
			["bun", "pm", "pack", "--destination", tempDir, "--quiet"],
			bridgeClientPackageDir,
		);
		const tuiTarball = run(["bun", "pm", "pack", "--destination", tempDir, "--quiet"], tuiPackageDir);
		const nativesTarball = run(["bun", "pm", "pack", "--destination", tempDir, "--quiet"], nativesPackageDir);
		const linuxX64Tarball = run(["bun", "pm", "pack", "--destination", tempDir, "--quiet"], stagedLinuxX64Dir);
		const codingAgentTarball = run(["bun", "pm", "pack", "--destination", tempDir, "--quiet"], packageDir);
		const aiTarballPath = path.isAbsolute(aiTarball) ? aiTarball : path.join(aiPackageDir, aiTarball);
		const bridgeClientTarballPath = path.isAbsolute(bridgeClientTarball)
			? bridgeClientTarball
			: path.join(bridgeClientPackageDir, bridgeClientTarball);
		const tuiTarballPath = path.isAbsolute(tuiTarball) ? tuiTarball : path.join(tuiPackageDir, tuiTarball);
		const nativesTarballPath = path.isAbsolute(nativesTarball)
			? nativesTarball
			: path.join(nativesPackageDir, nativesTarball);
		const linuxX64TarballPath = path.isAbsolute(linuxX64Tarball)
			? linuxX64Tarball
			: path.join(stagedLinuxX64Dir, linuxX64Tarball);
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
						"@gajae-code/tui": `file:${tuiTarballPath}`,
						"@gajae-code/natives": `file:${nativesTarballPath}`,
						"@gajae-code/natives-linux-x64": `file:${linuxX64TarballPath}`,
					},
					overrides: {
						"@gajae-code/ai": `file:${aiTarballPath}`,
						"@gajae-code/bridge-client": `file:${bridgeClientTarballPath}`,
						"@gajae-code/tui": `file:${tuiTarballPath}`,
						"@gajae-code/natives": `file:${nativesTarballPath}`,
						"@gajae-code/natives-linux-x64": `file:${linuxX64TarballPath}`,
					},
				},
				null,
				2,
			),
		);
		// Install the matching packed workspace artifacts so the smoke test exercises the
		// release dependency boundary without falling back to an older registry package.
		run(["bun", "install", "--ignore-scripts"], tempDir);
		const installedPackage = JSON.parse(
			await fs.readFile(path.join(tempDir, "node_modules", packageName, "package.json"), "utf8"),
		) as { exports?: Record<string, unknown> };
		if (installedPackage.exports?.["./session/internal/*"] !== null) {
			throw new Error("packed package must explicitly block ./session/internal/*");
		}
		const probePath = path.join(tempDir, "probe.ts");
		await fs.writeFile(
			probePath,
			`import * as fs from "node:fs/promises";\nimport * as path from "node:path";\nimport * as root from ${JSON.stringify(packageName)};\nimport * as sdk from ${JSON.stringify(`${packageName}/sdk`)};\nimport * as bus from ${JSON.stringify(`${packageName}/sdk/bus`)};\nconst required = [[root, "createAgentSession", "root"], [root, "SESSION_DIRECTORY_API_VERSION", "root"], [root, "resolveManagedSessionScope", "root"], [root, "listManagedSessionCandidates", "root"], [sdk, "createAgentSession", "sdk"], [bus, "createNotificationsExtension", "sdk/bus"], [sdk, "SdkClient", "sdk"], [sdk, "SESSION_DIRECTORY_API_VERSION", "sdk"], [sdk, "resolveManagedSessionScope", "sdk"], [sdk, "listManagedSessionCandidates", "sdk"]] as const;\nfor (const [module, name, subpath] of required) if (!(name in module)) throw new Error(subpath + " missing " + name);\nconst sandbox = path.join(process.cwd(), "managed-listing-smoke");\nconst cwd = path.join(sandbox, "workspace", "a-b", "c");\nconst agentDir = path.join(sandbox, "agent");\nconst sessionsRoot = path.join(agentDir, "sessions");\nawait fs.mkdir(cwd, { recursive: true });\nconst resolved = await sdk.resolveManagedSessionScope({ cwd, agentDir, sessionsRoot });\nif (resolved.kind !== "resolved") throw new Error("packed resolver failed: " + resolved.message);\nawait fs.mkdir(resolved.scope.directoryPath, { recursive: true, mode: 0o700 });\nawait fs.chmod(sessionsRoot, 0o700);\nawait fs.chmod(resolved.scope.directoryPath, 0o700);\nawait fs.writeFile(path.join(resolved.scope.directoryPath, ".gjc-managed-session-scope.v2.json"), JSON.stringify({ schemaVersion: 1, layoutVersion: 2, identityVersion: 1, platform: process.platform === "win32" ? "win32" : "posix", canonicalPath: resolved.scope.canonicalCwd, identityDigest: resolved.scope.directoryName.slice(3) }) + "\\n", { mode: 0o600 });\nconst transcriptPath = path.join(resolved.scope.directoryPath, "packed-session.jsonl");\nawait fs.writeFile(transcriptPath, JSON.stringify({ type: "session", id: "packed-session", cwd }) + "\\n", { mode: 0o600 });\nconst snapshot = async () => Promise.all((await fs.readdir(sandbox, { recursive: true })).sort().map(async name => { const pathname = path.join(sandbox, name); const stat = await fs.lstat(pathname); return [name, stat.mode, stat.size, stat.mtimeMs, stat.isFile() ? await fs.readFile(pathname, "utf8") : null]; }));\nconst before = JSON.stringify(await snapshot());\nconst listing = await sdk.listManagedSessionCandidates({ scope: resolved.scope });\nif (listing.kind !== "complete" || listing.owned.length !== 1 || listing.owned[0]?.sessionId !== "packed-session") throw new Error("packed readonly listing failed: " + JSON.stringify(listing));\nconst after = JSON.stringify(await snapshot());\nif (after !== before) throw new Error("packed readonly listing mutated the filesystem");\nconst privateSubpath = ${JSON.stringify(`${packageName}/session/internal/managed-session-scope`)};\ntry { await import(privateSubpath); throw new Error("private managed-session scope subpath resolved"); } catch (error) {\n\tif (error instanceof Error && error.message === "private managed-session scope subpath resolved") throw error;\n\tconst message = String(error);\n\tconst exportsRejected = /Package subpath .* is not defined by "exports"/.test(message);\n\tconst bunRejected = message.startsWith("ResolveMessage: Cannot find module '" + privateSubpath + "' from '") && message.endsWith("/probe.ts'");\n\tif (!exportsRejected && !bunRejected) throw new Error("private managed-session scope failed for an unexpected reason: " + message);\n}\nprocess.stdout.write(JSON.stringify({ root: Object.keys(root).sort(), sdk: Object.keys(sdk).sort() }));\n`,
		);
		await fs.appendFile(
			probePath,
			`\nconst rootBefore = JSON.stringify(await snapshot());\nconst rootListing = await root.listManagedSessionCandidates({ scope: resolved.scope });\nif (rootListing.kind !== "complete" || rootListing.owned.length !== listing.owned.length || rootListing.owned[0]?.sessionId !== listing.owned[0]?.sessionId || rootListing.owned[0]?.path !== listing.owned[0]?.path) throw new Error("packed root readonly listing diverged from SDK listing");\nconst rootAfter = JSON.stringify(await snapshot());\nif (rootAfter !== rootBefore) throw new Error("packed root readonly listing mutated the filesystem");\nconst bridgeClient = await import("@gajae-code/bridge-client");\nif (sdk.SdkClient !== bridgeClient.SdkClient) throw new Error("SdkClient class identity differs between sdk and bridge-client");\n`,
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
