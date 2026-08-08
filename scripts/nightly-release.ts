#!/usr/bin/env bun

import * as path from "node:path";
import { $, Glob } from "bun";
import { PUBLIC_PACKAGE_DEFINITIONS, nightlyVersionPattern, stableVersionPattern } from "./release-evidence";

export const NIGHTLY_VERSION_PATTERN = nightlyVersionPattern;
const sourceShaPattern = /^[0-9a-f]{40}$/u;
const positiveIntegerPattern = /^[1-9]\d*$/u;
const cargoManifestGlob = new Glob("crates/*/Cargo.toml");

interface PackageManifest {
	name?: unknown;
	version?: unknown;
	private?: unknown;
}

interface RootManifest {
	workspaces?: {
		catalog?: Record<string, unknown>;
	};
}

interface PendingWrite {
	path: string;
	content: string;
}

function compareNumericIdentifier(left: string, right: string): number {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	return left < right ? -1 : left > right ? 1 : 0;
}

function parseStableVersion(version: string): [string, string, string] {
	if (!stableVersionPattern.test(version)) throw new Error(`Expected exact stable X.Y.Z version, received ${version}`);
	return version.split(".") as [string, string, string];
}

function assertSourceSha(sourceSha: string): void {
	if (!sourceShaPattern.test(sourceSha)) throw new Error("Source SHA must be exactly 40 lowercase hexadecimal characters");
}
async function assertCheckedOutSourceSha(repoRoot: string, sourceSha: string): Promise<void> {
	assertSourceSha(sourceSha);
	const result = await $`git -c core.fsmonitor=false -c core.untrackedCache=false rev-parse HEAD`.cwd(repoRoot).quiet().nothrow();
	const checkedOutSha = result.stdout.toString().trim();
	if (result.exitCode !== 0 || checkedOutSha !== sourceSha) {
		throw new Error(`Checked-out source ${checkedOutSha || "<unresolved>"} does not match requested source ${sourceSha}`);
	}
}

function assertPositiveInteger(value: string, label: string): void {
	if (!positiveIntegerPattern.test(value)) throw new Error(`${label} must be a positive decimal integer without leading zeroes`);
}

function utcIdentifier(timestamp: Date): string {
	if (!Number.isFinite(timestamp.getTime())) throw new Error("Nightly timestamp must be a valid date");
	return timestamp.toISOString().replace(/[-:TZ.]/gu, "").slice(0, 14);
}

export function deriveNightlyVersion(
	stableVersions: readonly string[],
	timestamp: Date,
	runId: string,
	sourceSha: string,
): string {
	if (stableVersions.length === 0) throw new Error("Cannot derive a nightly version without public package versions");
	assertPositiveInteger(runId, "Run id");
	assertSourceSha(sourceSha);

	const parsed = stableVersions.map(parseStableVersion);
	const [major, minor] = parsed[0]!;
	if (parsed.some(([candidateMajor, candidateMinor]) => candidateMajor !== major || candidateMinor !== minor)) {
		throw new Error("All public packages must share one stable major/minor line before a nightly release");
	}
	const highestPatch = parsed.map(([, , patch]) => patch).reduce((highest, candidate) =>
		compareNumericIdentifier(candidate, highest) > 0 ? candidate : highest,
	);
	const nextPatch = (BigInt(highestPatch) + 1n).toString();
	return `${major}.${minor}.${nextPatch}-nightly.${utcIdentifier(timestamp)}.${runId}.g${sourceSha.slice(0, 12)}`;
}

function replaceSingle(text: string, pattern: RegExp, replacement: string, label: string): string {
	const matches = [...text.matchAll(pattern)];
	if (matches.length !== 1) throw new Error(`${label} must match exactly once, found ${matches.length}`);
	return text.replace(pattern, replacement);
}
function replaceVersionSentinel(text: string, replacement: string, label: string): string {
	const pattern = /__piNativesV[A-Za-z0-9_]+/gu;
	const matches = [...text.matchAll(pattern)].map(match => match[0]);
	if (matches.length === 0) throw new Error(`${label} must contain a version sentinel`);
	if (new Set(matches).size !== 1) throw new Error(`${label} contains conflicting version sentinels`);
	return text.replace(pattern, replacement);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertCurrentVersion(current: unknown, target: string, label: string): string {
	if (typeof current !== "string") throw new Error(`${label} has no string version`);
	if (current !== target && !stableVersionPattern.test(current)) {
		throw new Error(`${label} version ${current} is neither stable nor the requested nightly version`);
	}
	return current;
}

async function publicPackageVersions(repoRoot: string): Promise<string[]> {
	const versions: string[] = [];
	for (const definition of PUBLIC_PACKAGE_DEFINITIONS) {
		const manifestPath = path.join(repoRoot, definition.dir, "package.json");
		const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
		if (manifest.name !== definition.name || manifest.private === true) {
			throw new Error(`${definition.dir}/package.json does not match public package ${definition.name}`);
		}
		if (typeof manifest.version !== "string") throw new Error(`${definition.dir}/package.json has no string version`);
		versions.push(manifest.version);
	}
	return versions;
}

export async function deriveNightlyVersionFromRepo(
	repoRoot: string,
	timestamp: Date,
	runId: string,
	sourceSha: string,
): Promise<string> {
	return deriveNightlyVersion(await publicPackageVersions(repoRoot), timestamp, runId, sourceSha);
}

async function workspaceVersionedCrates(repoRoot: string): Promise<string[]> {
	const names: string[] = [];
	for await (const relativePath of cargoManifestGlob.scan(repoRoot)) {
		const content = await Bun.file(path.join(repoRoot, relativePath)).text();
		if (!/^version\.workspace\s*=\s*true$/mu.test(content)) continue;
		const name = content.match(/^name\s*=\s*"([^"]+)"$/mu)?.[1];
		if (name === undefined) throw new Error(`${relativePath} uses workspace version without a package name`);
		names.push(name);
	}
	return names.sort();
}

export async function stageNightlyVersion(repoRoot: string, version: string, sourceSha: string): Promise<string[]> {
	if (!NIGHTLY_VERSION_PATTERN.test(version)) throw new Error(`Invalid nightly version ${version}`);
	assertSourceSha(sourceSha);
	if (!version.endsWith(`.g${sourceSha.slice(0, 12)}`)) throw new Error("Nightly version source suffix does not match the checked-out commit");

	const writes: PendingWrite[] = [];
	for (const definition of PUBLIC_PACKAGE_DEFINITIONS) {
		const manifestPath = path.join(repoRoot, definition.dir, "package.json");
		const content = await Bun.file(manifestPath).text();
		const manifest = JSON.parse(content) as PackageManifest;
		if (manifest.name !== definition.name || manifest.private === true) {
			throw new Error(`${definition.dir}/package.json does not match public package ${definition.name}`);
		}
		assertCurrentVersion(manifest.version, version, `${definition.dir}/package.json`);
		writes.push({
			path: manifestPath,
			content: replaceSingle(content, /^(\s*"version"\s*:\s*)"[^"]+"/gmu, `$1"${version}"`, `${definition.dir}/package.json version`),
		});
	}

	const rootManifestPath = path.join(repoRoot, "package.json");
	let rootContent = await Bun.file(rootManifestPath).text();
	const rootManifest = JSON.parse(rootContent) as RootManifest;
	const catalog = rootManifest.workspaces?.catalog;
	if (catalog === undefined) throw new Error("Root package.json has no workspace catalog");
	for (const definition of PUBLIC_PACKAGE_DEFINITIONS.filter(candidate => candidate.name.startsWith("@gajae-code/"))) {
		assertCurrentVersion(catalog[definition.name], version, `root catalog ${definition.name}`);
		const pattern = new RegExp(`^(\\s*"${escapeRegExp(definition.name)}"\\s*:\\s*)"[^"]+"`, "gmu");
		rootContent = replaceSingle(rootContent, pattern, `$1"${version}"`, `root catalog ${definition.name}`);
	}
	writes.push({ path: rootManifestPath, content: rootContent });

	const cargoTomlPath = path.join(repoRoot, "Cargo.toml");
	const cargoToml = await Bun.file(cargoTomlPath).text();
	const workspaceVersion = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/mu)?.[1];
	assertCurrentVersion(workspaceVersion, version, "Cargo workspace");
	writes.push({
		path: cargoTomlPath,
		content: replaceSingle(
			cargoToml,
			/^(\[workspace\.package\][\s\S]*?^version\s*=\s*)"[^"]+"/gmu,
			`$1"${version}"`,
			"Cargo workspace version",
		),
	});

	let cargoLock = await Bun.file(path.join(repoRoot, "Cargo.lock")).text();
	for (const crateName of await workspaceVersionedCrates(repoRoot)) {
		const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${escapeRegExp(crateName)}"\\nversion = ")[^"]+(")`, "gu");
		cargoLock = replaceSingle(cargoLock, pattern, `$1${version}$2`, `Cargo.lock ${crateName}`);
	}
	writes.push({ path: path.join(repoRoot, "Cargo.lock"), content: cargoLock });

	const sentinel = `__piNativesV${version.replace(/[^A-Za-z0-9]/gu, "_")}`;
	for (const relativePath of [
		"crates/pi-natives/src/lib.rs",
		"packages/natives/native/index.d.ts",
		"packages/natives/native/index.js",
	]) {
		const filePath = path.join(repoRoot, relativePath);
		const content = await Bun.file(filePath).text();
		writes.push({
			path: filePath,
			content: replaceVersionSentinel(content, sentinel, `${relativePath} version sentinel`),
		});
	}

	for (const write of writes) await Bun.write(write.path, write.content);
	return writes.map(write => path.relative(repoRoot, write.path).replaceAll(path.sep, "/"));
}

function namedArguments(argv: readonly string[], expected: readonly string[]): Record<string, string> {
	if (argv.length !== expected.length * 2) throw new Error(`Expected exactly ${expected.join(", ")}`);
	const values: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (key === undefined || value === undefined || !expected.includes(key) || values[key] !== undefined || value.startsWith("--")) {
			throw new Error(`Expected exactly ${expected.join(", ")}`);
		}
		values[key] = value;
	}
	return values;
}

async function main(): Promise<void> {
	const [mode, ...argv] = process.argv.slice(2);
	const repoRoot = path.join(import.meta.dir, "..");
	if (mode === "version") {
		const values = namedArguments(argv, ["--timestamp", "--run-id", "--source-sha"]);
		await assertCheckedOutSourceSha(repoRoot, values["--source-sha"]!);
		const version = await deriveNightlyVersionFromRepo(
			repoRoot,
			new Date(values["--timestamp"]!),
			values["--run-id"]!,
			values["--source-sha"]!,
		);
		process.stdout.write(`${version}\n`);
		return;
	}
	if (mode === "stage") {
		const values = namedArguments(argv, ["--version", "--source-sha"]);
		await assertCheckedOutSourceSha(repoRoot, values["--source-sha"]!);
		const changedPaths = await stageNightlyVersion(repoRoot, values["--version"]!, values["--source-sha"]!);
		console.log(JSON.stringify({ ok: true, version: values["--version"], changedPaths }));
		return;
	}
	throw new Error("Use version --timestamp <iso> --run-id <id> --source-sha <sha>, or stage --version <version> --source-sha <sha>");
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
