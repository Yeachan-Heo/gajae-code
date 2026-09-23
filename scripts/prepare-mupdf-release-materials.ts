#!/usr/bin/env bun
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	MUPDF_EMSDK_VERSION,
	MUPDF_NPM_INTEGRITY,
	MUPDF_RELEASE_MATERIALS,
	MUPDF_SOURCE_ARCHIVE_BYTES,
	MUPDF_SOURCE_ARCHIVE_URL,
	MUPDF_SOURCE_TAG_COMMIT,
	MUPDF_VERSION,
	sha256,
	validateMuPdfSourceArchiveDigest,
	verifyMuPdfReleaseMaterials,
	type MuPdfProvenance,
} from "./mupdf-release-materials";

const repoRoot = path.resolve(import.meta.dir, "..");
const prepackScript = "bash tools/build.sh && bash tools/compress.sh";

interface InstalledMuPdf {
	modulePath: string;
	packageRoot: string;
	wasmPath: string;
}

interface MuPdfSourceLayout {
	packageRoot: string;
	buildingPath: string;
	copyingPath: string;
}

function usage(): never {
	throw new Error("Usage: bun scripts/prepare-mupdf-release-materials.ts --output-dir <dir>");
}

function parseOutputDirectory(argv: string[]): string {
	if (argv.length !== 2 || argv[0] !== "--output-dir" || !argv[1]) usage();
	return argv[1];
}

function capture(command: string[], cwd: string, env: NodeJS.ProcessEnv): string {
	const result = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const stdout = result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();
	if (result.exitCode !== 0) {
		throw new Error(`Required command failed (${command.join(" ")}): ${stderr || stdout || `exit ${result.exitCode}`}`);
	}
	return stdout || stderr;
}

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	const child = Bun.spawn(command, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`MuPDF source build command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

async function readFileBuffer(filePath: string): Promise<Buffer> {
	return Buffer.from(await Bun.file(filePath).arrayBuffer());
}

function npmPackage(): InstalledMuPdf {
	const codingAgent = path.join(repoRoot, "packages/coding-agent");
	let modulePath: string;
	try {
		modulePath = Bun.resolveSync("mupdf", codingAgent);
	} catch {
		throw new Error("Install repository dependencies first; Bun cannot resolve mupdf from packages/coding-agent");
	}
	return {
		modulePath,
		packageRoot: path.resolve(path.dirname(modulePath), ".."),
		wasmPath: path.join(path.dirname(modulePath), "mupdf-wasm.wasm"),
	};
}

async function verifyPinnedNpmPackage(installed: InstalledMuPdf): Promise<Buffer> {
	const lock = await Bun.file(path.join(repoRoot, "bun.lock")).text();
	if (!lock.includes(`"mupdf": ["mupdf@${MUPDF_VERSION}", "", {}, "${MUPDF_NPM_INTEGRITY}"]`)) {
		throw new Error("bun.lock does not bind the expected MuPDF npm integrity to mupdf 1.28.0");
	}
	const metadata = JSON.parse(await Bun.file(path.join(installed.packageRoot, "package.json")).text()) as {
		name?: unknown;
		version?: unknown;
	};
	if (metadata.name !== "mupdf" || metadata.version !== MUPDF_VERSION) {
		throw new Error(`Installed npm MuPDF must be mupdf ${MUPDF_VERSION}; found ${String(metadata.name)} ${String(metadata.version)}`);
	}
	const wasm = await readFileBuffer(installed.wasmPath).catch(() => {
		throw new Error(`Integrity-pinned npm MuPDF WASM is missing: ${installed.wasmPath}`);
	});
	if (wasm.length === 0) throw new Error("Integrity-pinned npm MuPDF WASM is empty");
	return wasm;
}

async function downloadOfficialSource(): Promise<Buffer> {
	let response: Response;
	try {
		response = await fetch(MUPDF_SOURCE_ARCHIVE_URL, { signal: AbortSignal.timeout(120_000) });
	} catch (error) {
		throw new Error(`Unable to download official MuPDF source archive: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`Official MuPDF source archive download failed: HTTP ${response.status}`);
	const archive = Buffer.from(await response.arrayBuffer());
	if (archive.length !== MUPDF_SOURCE_ARCHIVE_BYTES) {
		throw new Error(`Official MuPDF source archive has ${archive.length} bytes, expected ${MUPDF_SOURCE_ARCHIVE_BYTES}`);
	}
	const digest = sha256(archive);
	validateMuPdfSourceArchiveDigest(digest, { sha256: digest, bytes: archive.length });
	return archive;
}

function listArchiveEntries(archivePath: string, cwd: string): string[] {
	const output = capture(["tar", "-tzf", archivePath], cwd, process.env);
	const entries = output.split("\n").filter(Boolean).map(entry => entry.replace(/^\.\//, ""));
	if (entries.length === 0) throw new Error("MuPDF source archive is empty");
	for (const entry of entries) {
		if (entry.startsWith("/") || entry.split("/").includes("..")) throw new Error(`Unsafe path in pinned MuPDF source archive: ${entry}`);
	}
	return entries;
}

function sourceDirectory(workDirectory: string, entries: string[]): MuPdfSourceLayout {
	const roots = new Set(entries.map(entry => entry.split("/")[0]));
	if (roots.size !== 1) throw new Error("MuPDF source archive does not have one expected top-level directory");
	const archiveRoot = [...roots][0]!;
	const packageDirectories = entries
		.filter(entry => entry === "package.json" || entry.endsWith("/package.json"))
		.map(entry => path.posix.dirname(entry))
		.filter(directory => ["tools/build.sh", "tools/compress.sh"].every(name => entries.includes(path.posix.join(directory, name))));
	if (packageDirectories.length !== 1) {
		throw new Error(`Official MuPDF source archive must contain one package root with the upstream build scripts; found ${packageDirectories.length}`);
	}
	const packageRelative = packageDirectories[0]!;
	if (packageRelative !== "." && !packageRelative.startsWith(`${archiveRoot}/`)) {
		throw new Error("MuPDF npm package is outside the official source archive root");
	}
	const buildingPath = path.posix.join(packageRelative, "BUILDING.md");
	const copyingPath = path.posix.join(archiveRoot, "COPYING");
	for (const name of [buildingPath, copyingPath]) {
		if (!entries.includes(name)) throw new Error(`Official MuPDF source archive is missing ${name}`);
	}
	return {
		packageRoot: path.join(workDirectory, packageRelative),
		buildingPath: path.join(workDirectory, buildingPath),
		copyingPath: path.join(workDirectory, copyingPath),
	};
}

async function checkUpstreamPackage(sourceDirectory: string, installedDirectory: string): Promise<void> {
	const sourcePackage = JSON.parse(await Bun.file(path.join(sourceDirectory, "package.json")).text()) as Record<string, unknown>;
	const installedPackage = JSON.parse(await Bun.file(path.join(installedDirectory, "package.json")).text()) as Record<string, unknown>;
	// Artifex's 1.28.0 source archive retains the previous WASM package version;
	// its published npm manifest changes only that version field.
	if (sourcePackage.name !== "mupdf" || sourcePackage.version !== "1.27.0" || installedPackage.version !== MUPDF_VERSION) {
		throw new Error("Official source and installed npm package version metadata differ from the pinned release");
	}
	const sourceScripts = sourcePackage.scripts as Record<string, unknown> | undefined;
	if (sourceScripts?.prepack !== prepackScript) {
		throw new Error(`Official source prepack must invoke exactly: ${prepackScript}`);
	}
	const sourceMetadata = { ...sourcePackage };
	const installedMetadata = { ...installedPackage };
	delete sourceMetadata.version;
	delete installedMetadata.version;
	try {
		assert.deepStrictEqual(sourceMetadata, installedMetadata);
	} catch {
		throw new Error("Official source package metadata differs from pinned npm package beyond the published version");
	}
}

async function activateEmsdk(emsdk: string, cwd: string): Promise<string> {
	const environment = { ...process.env, EMSDK: emsdk };
	const activationFile = path.join(emsdk, "emsdk_env.sh");
	await fs.access(activationFile).catch(() => {
		throw new Error(`EMSDK does not contain emsdk_env.sh: ${emsdk}`);
	});
	const emccVersionOutput = capture(["bash", "-c", 'source "$EMSDK/emsdk_env.sh" >/dev/null && emcc --version'], cwd, environment);
	const version = emccVersionOutput.match(/\b\d+\.\d+\.\d+\b/)?.[0];
	if (version !== MUPDF_EMSDK_VERSION) {
		throw new Error(`MuPDF release build requires Emscripten ${MUPDF_EMSDK_VERSION}; found ${version ?? emccVersionOutput.split("\n")[0]}`);
	}
	return emccVersionOutput.split("\n")[0]!;
}

function buildRecipe(
	input: {
		nodeVersion: string;
		npmVersion: string;
		emccVersion: string;
		npmWasmSha256: string;
		rebuiltWasmSha256: string;
		archiveSha256: string;
		archiveBytes: number;
		building: Buffer;
		packageJson: Buffer;
		buildScript: Buffer;
		compressScript: Buffer;
	},
): string {
	const hashes = [
		["BUILDING.md", input.building],
		["package.json", input.packageJson],
		["tools/build.sh", input.buildScript],
		["tools/compress.sh", input.compressScript],
	].map(([name, bytes]) => `${name}: ${sha256(bytes)}`).join("\n");
	return [
		"MuPDF corresponding-source reproducible build recipe",
		`MuPDF version: ${MUPDF_VERSION}`,
		`Official source archive: ${MUPDF_SOURCE_ARCHIVE_URL}`,
		`Official source archive SHA-256: ${input.archiveSha256}`,
		`Official source archive bytes: ${input.archiveBytes}`,
		`Official source tag commit: ${MUPDF_SOURCE_TAG_COMMIT}`,
		`Pinned npm package integrity (bun.lock): ${MUPDF_NPM_INTEGRITY}`,
		`EMSDK version: ${MUPDF_EMSDK_VERSION}`,
		`emcc version output: ${input.emccVersion}`,
		`Node.js version: ${input.nodeVersion}`,
		`npm version: ${input.npmVersion}`,
		`Bun version: ${Bun.version}`,
		"",
		"Source archive extraction: tar -xzf mupdf-source.tar.gz",
		"Build commands (run in the upstream npm package root after extracting the verified archive):",
		"1. source \"$EMSDK/emsdk_env.sh\"",
		"2. npm install --ignore-scripts",
		"3. npm run prepack",
		`4. upstream package.json prepack: ${prepackScript}`,
		"No source edits or build-option overrides were applied.",
		"",
		"Binary comparison:",
		`Installed npm dist/mupdf-wasm.wasm SHA-256: ${input.npmWasmSha256}`,
		`Source-built dist/mupdf-wasm.wasm SHA-256: ${input.rebuiltWasmSha256}`,
		`Exact SHA-256 equality: ${input.npmWasmSha256 === input.rebuiltWasmSha256}`,
		"",
		"Hashes of copied upstream build inputs:",
		hashes,
		"",
		"Upstream build script contents (the hashes above bind these exact source files):",
		"--- tools/build.sh ---",
		input.buildScript.toString("utf8").trimEnd(),
		"--- tools/compress.sh ---",
		input.compressScript.toString("utf8").trimEnd(),
		"",
	].join("\n");
}

async function prepareReleaseMaterials(outputDirectory: string): Promise<{ directory: string; wasmPath: string }> {
	const emsdk = process.env.EMSDK;
	if (!emsdk) throw new Error("EMSDK must point to installed Emscripten 4.0.8");
	const emsdkRoot = await fs.realpath(emsdk).catch(() => {
		throw new Error(`EMSDK directory does not exist: ${emsdk}`);
	});
	capture(["node", "--version"], repoRoot, process.env);
	capture(["npm", "--version"], repoRoot, process.env);
	const installed = npmPackage();
	const npmWasm = await verifyPinnedNpmPackage(installed);
	const npmWasmSha256 = sha256(npmWasm);
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mupdf-source-build-"));
	try {
		const archive = await downloadOfficialSource();
		const archivePath = path.join(temporaryDirectory, "mupdf-source.tar.gz");
		await Bun.write(archivePath, archive, { mode: 0o600, createPath: false });
		const entries = listArchiveEntries(archivePath, temporaryDirectory);
		await run(["tar", "-xzf", archivePath, "-C", temporaryDirectory], temporaryDirectory, process.env);
		const sourceLayout = sourceDirectory(temporaryDirectory, entries);
		await checkUpstreamPackage(sourceLayout.packageRoot, installed.packageRoot);
		const environment: NodeJS.ProcessEnv = { ...process.env, EMSDK: emsdkRoot };
		for (const name of ["BUILD", "DEFINES", "FEATURES", "SUFFIX"]) delete environment[name];
		const emccVersion = await activateEmsdk(emsdkRoot, sourceLayout.packageRoot);
		const nodeVersion = capture(["bash", "-c", 'source "$EMSDK/emsdk_env.sh" >/dev/null && node --version'], sourceLayout.packageRoot, environment);
		const npmVersion = capture(["bash", "-c", 'source "$EMSDK/emsdk_env.sh" >/dev/null && npm --version'], sourceLayout.packageRoot, environment);
		await run(
			["bash", "-c", 'source "$EMSDK/emsdk_env.sh" >/dev/null && npm install --ignore-scripts && npm run prepack'],
			sourceLayout.packageRoot,
			environment,
		);
		const builtWasmPath = path.join(sourceLayout.packageRoot, "dist", "mupdf-wasm.wasm");
		const [rebuiltWasm, building, packageJson, buildScript, compressScript, sourceCopying, npmLicense] = await Promise.all([
			readFileBuffer(builtWasmPath).catch(() => {
				throw new Error("Official MuPDF source prepack completed without producing dist/mupdf-wasm.wasm");
			}),
			readFileBuffer(sourceLayout.buildingPath),
			readFileBuffer(path.join(sourceLayout.packageRoot, "package.json")),
			readFileBuffer(path.join(sourceLayout.packageRoot, "tools/build.sh")),
			readFileBuffer(path.join(sourceLayout.packageRoot, "tools/compress.sh")),
			readFileBuffer(sourceLayout.copyingPath),
			readFileBuffer(path.join(installed.packageRoot, "LICENSE")),
		]);
		if (rebuiltWasm.length === 0) throw new Error("Official MuPDF source prepack produced an empty dist/mupdf-wasm.wasm");
		const rebuiltWasmSha256 = sha256(rebuiltWasm);
		if (!rebuiltWasm.equals(npmWasm)) {
			throw new Error(`MuPDF source rebuild does not match the integrity-pinned npm WASM: npm ${npmWasmSha256}, rebuilt ${rebuiltWasmSha256}`);
		}
		const recipe = buildRecipe({
			nodeVersion,
			npmVersion,
			emccVersion,
			npmWasmSha256,
			rebuiltWasmSha256,
			archiveSha256: sha256(archive),
			archiveBytes: archive.length,
			building,
			packageJson,
			buildScript,
			compressScript,
		});
		const notices = [
			"MuPDF source notices (official source archive COPYING)",
			"",
			sourceCopying.toString("utf8").trimEnd(),
			"",
			"MuPDF npm package notices (integrity-pinned mupdf package LICENSE)",
			"",
			npmLicense.toString("utf8").trimEnd(),
			"",
		].join("\n");
		const provenance: MuPdfProvenance = {
			schema: "gajae-mupdf-corresponding-source-v1",
			mupdfVersion: MUPDF_VERSION,
			sourceArtifact: "mupdf-source.tar.gz",
			buildRecipe: "mupdf-build-recipe.txt",
			notices: "mupdf-notices.txt",
			sourceArchiveUrl: MUPDF_SOURCE_ARCHIVE_URL,
			sourceArchiveSha256: sha256(archive),
			sourceTagCommit: MUPDF_SOURCE_TAG_COMMIT,
			emsdkVersion: MUPDF_EMSDK_VERSION,
			npmIntegrity: MUPDF_NPM_INTEGRITY,
			npmWasmSha256,
			rebuiltWasmSha256,
			wasmHashesMatch: true,
			buildRecipeSha256: sha256(recipe),
			noticesSha256: sha256(notices),
		};
		const stageDirectory = path.join(temporaryDirectory, "materials");
		await fs.mkdir(stageDirectory);
		await Promise.all([
			Bun.write(path.join(stageDirectory, "mupdf-source.tar.gz"), archive, { createPath: false }),
			Bun.write(path.join(stageDirectory, "mupdf-built.wasm"), rebuiltWasm, { createPath: false }),
			Bun.write(path.join(stageDirectory, "mupdf-build-recipe.txt"), recipe, { createPath: false }),
			Bun.write(path.join(stageDirectory, "mupdf-notices.txt"), notices, { createPath: false }),
			Bun.write(path.join(stageDirectory, "mupdf-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, { createPath: false }),
		]);
		await verifyMuPdfReleaseMaterials(stageDirectory);
		const resolvedOutputDirectory = path.resolve(outputDirectory);
		await fs.mkdir(resolvedOutputDirectory, { recursive: true });
		const publishOrder = MUPDF_RELEASE_MATERIALS;
		const publishDirectory = await fs.mkdtemp(path.join(resolvedOutputDirectory, ".mupdf-release-materials-"));
		try {
			for (const name of publishOrder) {
				await Bun.write(path.join(publishDirectory, name), Bun.file(path.join(stageDirectory, name)), { createPath: false });
			}
			for (const name of publishOrder) await fs.rename(path.join(publishDirectory, name), path.join(resolvedOutputDirectory, name));
		} finally {
			await fs.rm(publishDirectory, { recursive: true, force: true });
		}
		return verifyMuPdfReleaseMaterials(resolvedOutputDirectory);
	} finally {
		await fs.rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const outputDirectory = parseOutputDirectory(Bun.argv.slice(2));
	const result = await prepareReleaseMaterials(outputDirectory);
	console.log(`Verified corresponding-source MuPDF materials in ${result.directory}`);
	console.log(`Source-built WASM: ${result.wasmPath}`);
}

if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
