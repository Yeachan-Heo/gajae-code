#!/usr/bin/env bun
/**
 * Publish workspace packages.
 *
 * For each public package we:
 *   1. Emit publish declarations, stage native artifacts, and rewrite the
 *      publish-shaped manifest in the CI checkout.
 *   2. Pack every package twice from clean copies, canonicalize safe ustar/gzip
 *      bytes, retain the exact `.tgz`, and write closed expected evidence before
 *      the first registry mutation.
 *   3. Publish only those retained `.tgz` files. Existing same-version packages
 *      are resumed only after registry tarball, raw package/package.json bytes,
 *      SRI, and resolved internal dependencies match expected evidence.
 *   4. Write final closed evidence only after all 14 packages verify.
 *
 * Use `--prepare-evidence` first, upload expected evidence to the draft release,
 * then use `--publish-from-evidence --release-serialization-key <shared-cross-version-key>`
 * with the same evidence directory. Intended for CI; preparation rewrites package manifests in the checkout.
 */

import { createHash } from "node:crypto";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	EXPECTED_EVIDENCE_FILE,
	FINAL_EVIDENCE_FILE,
	PUBLIC_PACKAGE_DEFINITIONS,
	RELEASE_TARBALL_LIMITS,
	assertExactInternalReleaseDependencies,
	assertMonotonicLatestVersion,

	compareStableVersions,


	canonicalizePackageTarball,
	classifyRegistryObservation,
	createExpectedEvidence,
	createFinalEvidence,
	inspectPackageTarball,
	packageEvidenceFromTarball,
	readExpectedEvidenceFile,
	selfTest as releaseEvidenceSelfTest,
	sha512Sri,
	validateExpectedTarball,
	writeImmutableBytes,
	writeImmutableEvidence,
	type PackageEvidenceRecord,
	type RegistryPackageObservation,
} from "./release-evidence";


interface PublishPackage {
	dir: string;
	kind: "typescript" | "native" | "native-platform" | "manifest";
	/** Extra build steps before manifest rewrite (e.g. esbuild bundles). */
	preBuild?: readonly (readonly string[])[];
	/** Extra entries to splice into `files`. */
	extraFiles?: readonly string[];
	/** Extra TypeScript declaration configs beyond `tsconfig.publish.json`. */
	extraTypeConfigs?: readonly string[];
	/** Native addon filename prefixes staged into a per-platform optional package. */
	nativePrefixes?: readonly string[];
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}
interface PackageManifest {
	[key: string]: JsonValue | undefined;
	name?: string;
	version?: string;
	private?: boolean;
}

const repoRoot = path.join(import.meta.dir, "..");
let isDryRun = false;

export const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
export const NPM_RELEASE_TAG = "latest";
const npmRegistryOrigin = new URL(NPM_REGISTRY_URL).origin;
const maxTarballRedirects = 3;
const releaseSerializationKeyPattern = /^[a-z0-9][a-z0-9._/-]{7,127}$/u;


export type ReleasePublishCli =
	| { mode: "evidence-self-test" }
	| { mode: "check-types" }
	| { mode: "dry-run" }
	| { mode: "prepare-evidence"; evidenceDir: string }
	| { mode: "publish-from-evidence"; evidenceDir: string; releaseSerializationKey: string };


function parseEvidenceDirectory(mode: string, argv: readonly string[]): string {
	if (argv.length !== 2 || argv[0] !== "--evidence-dir" || argv[1] === undefined || argv[1].startsWith("--")) {
		throw new Error(`${mode} requires exactly --evidence-dir <directory>`);
	}
	return argv[1];
}

function parsePublishEvidenceOptions(argv: readonly string[]): { evidenceDir: string; releaseSerializationKey: string } {
	if (
		argv.length !== 4 ||
		argv[0] !== "--evidence-dir" ||
		argv[1] === undefined ||
		argv[1].startsWith("--") ||
		argv[2] !== "--release-serialization-key" ||
		argv[3] === undefined ||
		!releaseSerializationKeyPattern.test(argv[3])
	) {
		throw new Error("--publish-from-evidence requires exactly --evidence-dir <directory> --release-serialization-key <shared-cross-version-key>");
	}
	return { evidenceDir: argv[1], releaseSerializationKey: argv[3] };
}


export function parseReleasePublishCli(argv: readonly string[]): ReleasePublishCli {
	const [mode, ...argumentsForMode] = argv;
	switch (mode) {
		case "--evidence-self-test":
			if (argumentsForMode.length !== 0) throw new Error("--evidence-self-test cannot be combined with other arguments");
			return { mode: "evidence-self-test" };
		case "--check-types":
			if (argumentsForMode.length !== 0) throw new Error("--check-types cannot be combined with other arguments");
			return { mode: "check-types" };
		case "--dry-run":
			if (argumentsForMode.length !== 0) throw new Error("--dry-run cannot be combined with other arguments");
			return { mode: "dry-run" };
		case "--prepare-evidence":
			return { mode: "prepare-evidence", evidenceDir: parseEvidenceDirectory(mode, argumentsForMode) };
		case "--publish-from-evidence":
			return { mode: "publish-from-evidence", ...parsePublishEvidenceOptions(argumentsForMode) };
		default:
			throw new Error("Use exactly one mode: --evidence-self-test, --check-types, --dry-run, --prepare-evidence --evidence-dir <directory>, or --publish-from-evidence --evidence-dir <directory> --release-serialization-key <shared-cross-version-key>");

	}
}
const nativePlatformPackages: readonly PublishPackage[] = [
	{ dir: "packages/natives-darwin-arm64", kind: "native-platform", nativePrefixes: ["pi_natives.darwin-arm64"] },
	{ dir: "packages/natives-darwin-x64", kind: "native-platform", nativePrefixes: ["pi_natives.darwin-x64"] },
	{ dir: "packages/natives-linux-arm64", kind: "native-platform", nativePrefixes: ["pi_natives.linux-arm64"] },
	{ dir: "packages/natives-linux-x64", kind: "native-platform", nativePrefixes: ["pi_natives.linux-x64"] },
	{ dir: "packages/natives-win32-x64", kind: "native-platform", nativePrefixes: ["pi_natives.win32-x64"] },
];

export const packages: PublishPackage[] = [
	{ dir: "packages/utils", kind: "typescript" },
	{ dir: "packages/ai", kind: "typescript" },
	...nativePlatformPackages,
	{ dir: "packages/natives", kind: "native" },
	{ dir: "packages/tui", kind: "typescript" },
	{
		dir: "packages/stats",
		kind: "typescript",
		preBuild: [["bun", "run", "build"]],
		extraFiles: ["dist/client"],
		extraTypeConfigs: ["tsconfig.publish.client.json"],
	},
	{ dir: "packages/agent", kind: "typescript" },
	{ dir: "packages/coding-agent", kind: "typescript" },
	{ dir: "packages/gajae-code", kind: "manifest" },
];
const dependencyFieldNames = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

let rootCatalog: Readonly<Record<string, string>> | undefined;
let workspaceVersions: Readonly<Record<string, string>> | undefined;

function asStringRecord(value: JsonValue | undefined): Record<string, string> {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const record: Record<string, string> = {};
	for (const key in value) {
		const entry = (value as JsonObject)[key];
		if (typeof entry === "string") record[key] = entry;
	}
	return record;
}

async function loadRootCatalog(): Promise<Readonly<Record<string, string>>> {
	if (rootCatalog !== undefined) return rootCatalog;
	const manifest = (await Bun.file(path.join(repoRoot, "package.json")).json()) as PackageManifest;
	if (manifest.workspaces === null || typeof manifest.workspaces !== "object" || Array.isArray(manifest.workspaces)) {
		rootCatalog = {};
		return rootCatalog;
	}
	rootCatalog = asStringRecord((manifest.workspaces as JsonObject).catalog);
	return rootCatalog;
}

async function loadWorkspaceVersions(): Promise<Readonly<Record<string, string>>> {
	if (workspaceVersions !== undefined) return workspaceVersions;
	const versions: Record<string, string> = {};
	for (const pkg of packages) {
		const manifest = (await Bun.file(path.join(repoRoot, pkg.dir, "package.json")).json()) as PackageManifest;
		if (typeof manifest.name === "string" && typeof manifest.version === "string") {
			versions[manifest.name] = manifest.version;
		}
	}
	workspaceVersions = versions;
	return workspaceVersions;
}

export function normalizeFileDependencySpec(spec: string): string {
	if (!spec.startsWith("file:")) return spec;
	return `file:${spec.replace(/^(?:file:)+/u, "")}`;
}

function rewriteSrcPath(value: string): string {
	if (!value.startsWith("./src/")) return value;
	const rel = value.slice("./src/".length).replace(/\.tsx?$/, "");
	return `./dist/types/${rel}.d.ts`;
}

export async function resolvePublishDependency(name: string, spec: string): Promise<string> {
	let resolved = normalizeFileDependencySpec(spec);
	if (spec === "catalog:" || spec.startsWith("catalog:")) {
		const catalog = await loadRootCatalog();
		const catalogEntry = catalog[name];
		if (catalogEntry === undefined) throw new Error(`Missing catalog version for ${name}`);
		resolved = normalizeFileDependencySpec(catalogEntry);
	}
	if (resolved === "workspace:*" || resolved.startsWith("workspace:")) {
		const versions = await loadWorkspaceVersions();
		const workspaceVersion = versions[name];
		if (workspaceVersion === undefined) throw new Error(`Missing workspace package version for ${name}`);
		return workspaceVersion;
	}
	return normalizeFileDependencySpec(resolved);
}

async function rewriteDependencyFields(manifest: PackageManifest): Promise<void> {
	for (const fieldName of dependencyFieldNames) {
		const field = manifest[fieldName];
		if (field === undefined || field === null || typeof field !== "object" || Array.isArray(field)) continue;
		const dependencies = field as JsonObject;
		for (const dependencyName in dependencies) {
			const spec = dependencies[dependencyName];
			if (typeof spec === "string") {
				dependencies[dependencyName] = await resolvePublishDependency(dependencyName, spec);
			}
		}
	}
}

export function validateNpmRegistryUrl(value: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} is not a valid npm registry URL`);
	}
	if (
		url.origin !== npmRegistryOrigin ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new Error(`${label} must be ${NPM_REGISTRY_URL}`);
	}
	return url;
}

export function validateNpmRegistryTarballUrl(value: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} is not a valid registry tarball URL`);
	}
	if (
		url.origin !== npmRegistryOrigin ||
		url.pathname === "/" ||
		url.hash !== "" ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new Error(`${label} must remain on ${npmRegistryOrigin}`);
	}
	return url;
}

function assertPinnedPackagePublishConfig(manifest: PackageManifest, pkgDir: string): void {
	const publishConfig = manifest.publishConfig;
	if (publishConfig === undefined) return;
	if (publishConfig === null || typeof publishConfig !== "object" || Array.isArray(publishConfig)) {
		throw new Error(`publishConfig for ${pkgDir} must be an object`);
	}
	const config = publishConfig as JsonObject;
	if (config.registry !== undefined) {
		if (typeof config.registry !== "string") throw new Error(`publishConfig.registry for ${pkgDir} must be a string`);
		validateNpmRegistryUrl(config.registry, `publishConfig.registry for ${pkgDir}`);
	}
	if (config.tag !== undefined && config.tag !== NPM_RELEASE_TAG) {
		throw new Error(`publishConfig.tag for ${pkgDir} must be ${NPM_RELEASE_TAG}`);
	}
}

function rewriteExports(exports: JsonValue): JsonValue {
	if (exports === null || typeof exports !== "object" || Array.isArray(exports)) return exports;
	const src = exports as JsonObject;
	const out: JsonObject = {};
	for (const key in src) {
		const val = src[key];
		if (
			val !== null &&
			typeof val === "object" &&
			!Array.isArray(val) &&
			typeof (val as JsonObject).types === "string" &&
			((val as JsonObject).types as string).startsWith("./src/")
		) {
			const next: JsonObject = { ...(val as JsonObject) };
			next.types = rewriteSrcPath(next.types as string);
			out[key] = next;
		} else {
			out[key] = val;
		}
	}
	return out;
}

async function rewriteManifest(pkgDir: string, extraFiles: readonly string[]): Promise<PackageManifest> {
	const manifestPath = path.join(pkgDir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	await rewriteDependencyFields(manifest);
	if (typeof manifest.types === "string" && manifest.types.startsWith("./src/")) {
		manifest.types = rewriteSrcPath(manifest.types);
	}
	if (manifest.exports !== undefined) manifest.exports = rewriteExports(manifest.exports);
	const files = Array.isArray(manifest.files) ? [...manifest.files] : [];
	const hasDist = files.includes("dist");
	if (!hasDist && !files.includes("dist/types")) files.push("dist/types");
	for (const extra of extraFiles) {
		if (!hasDist && !files.includes(extra)) files.push(extra);
	}
	manifest.files = files;
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

async function rewriteNativeManifest(pkgDir: string): Promise<PackageManifest> {
	const manifestPath = path.join(pkgDir, "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
	await rewriteDependencyFields(manifest);
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

async function stageNativePlatformArtifacts(pkg: PublishPackage): Promise<void> {
	const prefixes = pkg.nativePrefixes ?? [];
	if (prefixes.length === 0) throw new Error(`Native platform package ${pkg.dir} has no nativePrefixes`);
	const sourceDir = path.join(repoRoot, "packages", "natives", "native");
	const targetDir = path.join(repoRoot, pkg.dir, "native");
	if (isDryRun) {
		console.log(`DRY RUN stage ${prefixes.join(",")} into ${pkg.dir}/native`);
		return;
	}

	const entries = await fs.readdir(sourceDir).catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Cannot read native artifact directory ${sourceDir}: ${message}`);
	});
	const matching = entries.filter(entry => entry.endsWith(".node") && prefixes.some(prefix => entry.startsWith(prefix)));
	if (matching.length === 0) {
		throw new Error(`No native artifacts matching ${prefixes.join(", ")} found in ${sourceDir}`);
	}

	await fs.rm(targetDir, { recursive: true, force: true });
	await fs.mkdir(targetDir, { recursive: true });
	for (const entry of matching) {
		await fs.copyFile(path.join(sourceDir, entry), path.join(targetDir, entry));
	}
}

async function emitTypeDeclarations(pkg: PublishPackage, temporaryRoot?: string): Promise<void> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	const configs = ["tsconfig.publish.json", ...(pkg.extraTypeConfigs ?? [])];
	for (const config of configs) {
		if (temporaryRoot === undefined) {
			await $`bun x tsc -p ${config}`.cwd(pkgDir);
			continue;
		}
		const outputName = path.basename(config, path.extname(config));
		const outputDir = path.join(temporaryRoot, pkg.dir.replaceAll(/[\\/]/g, "__"), outputName);
		await fs.mkdir(outputDir, { recursive: true });
		await $`bun x tsc -p ${config} --outDir ${outputDir}`.cwd(pkgDir);
	}
}

async function checkTypeDeclarations(): Promise<void> {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-code-types-"));
	try {
		for (const pkg of packages) {
			if (pkg.kind !== "typescript") continue;
			await emitTypeDeclarations(pkg, temporaryRoot);
			console.log(`Checked declarations (${pkg.dir})`);
		}
	} finally {
		await fs.rm(temporaryRoot, { recursive: true, force: true });
	}
}

async function preparePackage(pkg: PublishPackage): Promise<PackageManifest> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	let manifest: PackageManifest;
	if (pkg.kind === "native-platform") {
		await stageNativePlatformArtifacts(pkg);
		manifest = await rewriteNativeManifest(pkgDir);
	} else if (pkg.kind === "native" || pkg.kind === "manifest") {
		manifest = await rewriteNativeManifest(pkgDir);
	} else {
		for (const argv of pkg.preBuild ?? []) {
			await $`${argv}`.cwd(pkgDir);
		}
		await emitTypeDeclarations(pkg);
		manifest = await rewriteManifest(pkgDir, pkg.extraFiles ?? []);
	}
	assertPinnedPackagePublishConfig(manifest, pkg.dir);
	return manifest;
}

async function readPackageManifest(pkgDir: string): Promise<PackageManifest> {
	return (await Bun.file(path.join(pkgDir, "package.json")).json()) as PackageManifest;
}

interface PreparedPackage {
	pkg: PublishPackage;
	manifest: PackageManifest;
}

function outputOf(result: { stdout: Uint8Array; stderr: Uint8Array }): string {
	return `${Buffer.from(result.stdout).toString()}${Buffer.from(result.stderr).toString()}`.trim();
}

function optionalNpmConfigValue(value: string): string | undefined {
	const normalized = value.trim();
	return normalized === "" || normalized === "undefined" || normalized === "null" ? undefined : normalized;
}

async function readNpmConfig(key: string): Promise<string | undefined> {
	const result = await $`npm config get ${key}`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`Cannot read npm configuration ${key}: ${outputOf(result) || `exit ${result.exitCode ?? "unknown"}`}`);
	return optionalNpmConfigValue(outputOf(result));
}

async function assertPinnedNpmConfiguration(): Promise<void> {
	const registry = await readNpmConfig("registry");
	if (registry !== undefined) validateNpmRegistryUrl(registry, "ambient npm registry");
	const scopedRegistry = await readNpmConfig("@gajae-code:registry");
	if (scopedRegistry !== undefined) validateNpmRegistryUrl(scopedRegistry, "@gajae-code npm registry");
	const tag = await readNpmConfig("tag");
	if (tag !== undefined && tag !== NPM_RELEASE_TAG) {
		throw new Error(`ambient npm tag must be ${NPM_RELEASE_TAG}`);
	}
}

function assertPublishConfiguration(): void {
	const actual = packages.map(pkg => pkg.dir).sort();
	const expected = PUBLIC_PACKAGE_DEFINITIONS.map(definition => definition.dir).sort();
	if (actual.length !== expected.length || actual.some((dir, index) => dir !== expected[index])) {
		throw new Error("Publish package configuration must equal the complete public evidence package set");
	}
}

async function sourceCommit(): Promise<string> {
	const result = await $`git rev-parse HEAD`.quiet().nothrow();
	const commit = result.stdout.toString().trim();
	if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
		throw new Error("Cannot resolve the checked-out source commit for release evidence");
	}
	return commit;
}

async function packPackageTwice(pkg: PublishPackage): Promise<Buffer> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	const canonicalTarballs: Buffer[] = [];
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-code-release-pack-"));
		try {
			const copiedPackageDir = path.join(temporaryRoot, "package");
			const packOutputDir = path.join(temporaryRoot, "tarballs");
			await fs.cp(pkgDir, copiedPackageDir, { recursive: true, force: false, errorOnExist: true });
			await fs.mkdir(packOutputDir);
			const result = await $`npm pack --ignore-scripts --json --pack-destination ${packOutputDir}`.cwd(copiedPackageDir).quiet().nothrow();
			if (result.exitCode !== 0) throw new Error(`npm pack failed for ${pkg.dir}: ${outputOf(result)}`);
			const outputs = (await fs.readdir(packOutputDir)).filter(file => file.endsWith(".tgz"));
			if (outputs.length !== 1) throw new Error(`npm pack produced ${outputs.length} tarballs for ${pkg.dir}, expected one`);
			canonicalTarballs.push(canonicalizePackageTarball(await fs.readFile(path.join(packOutputDir, outputs[0]!))));
		} finally {
			await fs.rm(temporaryRoot, { recursive: true, force: true });
		}
	}
	if (!canonicalTarballs[0]!.equals(canonicalTarballs[1]!)) {
		throw new Error(`Deterministic pack mismatch for ${pkg.dir}; do not publish non-reproducible bytes`);
	}
	return canonicalTarballs[0]!;
}

function isMissingFile(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

export async function retainTarball(evidenceDirectory: string, record: PackageEvidenceRecord, tarball: Buffer): Promise<string> {
	validateExpectedTarball(record, tarball);
	const target = path.join(evidenceDirectory, "tarballs", `${record.tarball_sha512}.tgz`);
	await writeImmutableBytes(target, tarball);
	return target;
}

async function prepareExpectedEvidence(evidenceDirectory: string): Promise<{ path: string; sha256: string }> {
	assertPublishConfiguration();
	await assertPinnedNpmConfiguration();
	const prepared: PreparedPackage[] = [];
	for (const pkg of packages) {
		const manifest = await preparePackage(pkg);
		if (manifest.private === true) throw new Error(`Public release package ${pkg.dir} is private after preparation`);
		prepared.push({ pkg, manifest });
	}

	const packageRecords: PackageEvidenceRecord[] = [];
	let releaseVersion: string | undefined;
	for (const preparedPackage of prepared) {
		const definition = PUBLIC_PACKAGE_DEFINITIONS.find(candidate => candidate.dir === preparedPackage.pkg.dir);
		if (definition === undefined) throw new Error(`No evidence definition exists for ${preparedPackage.pkg.dir}`);
		const tarball = await packPackageTwice(preparedPackage.pkg);
		const record = packageEvidenceFromTarball(definition, tarball);
		if (preparedPackage.manifest.name !== record.name || preparedPackage.manifest.version !== record.version) {
			throw new Error(`Prepared manifest and retained tarball disagree for ${preparedPackage.pkg.dir}`);
		}
		if (releaseVersion === undefined) releaseVersion = record.version;
		if (record.version !== releaseVersion) throw new Error("All public packages must share one stable release version");
		await retainTarball(evidenceDirectory, record, tarball);
		packageRecords.push(record);
	}
	if (releaseVersion === undefined) throw new Error("No public packages were prepared for release evidence");
	const expected = createExpectedEvidence({
		sourceCommit: await sourceCommit(),
		releaseVersion,
		packages: packageRecords.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
	});
	const expectedPath = path.join(evidenceDirectory, EXPECTED_EVIDENCE_FILE);
	const digest = await writeImmutableEvidence(expectedPath, expected);
	console.log(JSON.stringify({
		ok: true,
		phase: "expected-evidence",
		expected_evidence: expectedPath,
		expected_evidence_sha256: digest,
		retained_tarballs: expected.packages.length,
	}));
	return { path: expectedPath, sha256: digest };
}

function isMissingRegistryPackage(output: string): boolean {
	return /\bE404\b|404 Not Found|is not in this registry/iu.test(output);
}

function parseRegistryDist(value: unknown, packageName: string): { integrity: string; tarball: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`npm view returned an invalid dist object for ${packageName}`);
	}
	const direct = value as Record<string, unknown>;
	const dist = direct.dist !== undefined && direct.dist !== null && typeof direct.dist === "object" && !Array.isArray(direct.dist)
		? direct.dist as Record<string, unknown>
		: direct;
	if (typeof dist.integrity !== "string" || typeof dist.tarball !== "string") {
		throw new Error(`npm view returned incomplete dist metadata for ${packageName}`);
	}
	validateNpmRegistryTarballUrl(dist.tarball, `npm view tarball for ${packageName}`);
	return { integrity: dist.integrity, tarball: dist.tarball };
}

function parseLatestRegistryDist(value: unknown, packageName: string): { version: string; dist: { integrity: string; tarball: string } } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`npm view returned invalid latest metadata for ${packageName}`);
	}
	const latest = value as Record<string, unknown>;
	if (typeof latest.version !== "string" || latest.dist === undefined) {
		throw new Error(`npm view returned incomplete latest metadata for ${packageName}`);
	}
	return { version: latest.version, dist: parseRegistryDist(latest.dist, `${packageName}@${NPM_RELEASE_TAG}`) };
}

function assertContentLengthWithinLimit(response: Response, maxCompressedBytes: number): void {
	const contentLength = response.headers.get("content-length");
	if (contentLength === null) return;
	if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) throw new Error("Registry tarball response has an invalid Content-Length");
	const length = Number(contentLength);
	if (!Number.isSafeInteger(length) || length > maxCompressedBytes) {
		throw new Error(`Registry tarball compressed size exceeds ${maxCompressedBytes} bytes`);
	}
}

export interface RegistryTarballDownloadOptions {
	fetcher?: typeof fetch;
	maxCompressedBytes?: number;
}

/** Streams only same-origin npm bytes, checks the compressed SRI, then permits inspection. */
export async function downloadNpmRegistryTarball(
	tarballUrl: string,
	expectedSri: string,
	options: RegistryTarballDownloadOptions = {},
): Promise<Buffer> {
	const fetcher = options.fetcher ?? fetch;
	const maxCompressedBytes = options.maxCompressedBytes ?? RELEASE_TARBALL_LIMITS.maxCompressedBytes;
	if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes <= 0) {
		throw new Error("Registry tarball compressed-size limit must be a positive safe integer");
	}
	let current = validateNpmRegistryTarballUrl(tarballUrl, "registry tarball URL");
	for (let redirects = 0; ; redirects += 1) {
		const response = await fetcher(current.href, { redirect: "manual", headers: { accept: "application/octet-stream" } });
		if (response.status >= 300 && response.status < 400) {
			if (redirects >= maxTarballRedirects) throw new Error("Registry tarball redirect limit exceeded");
			const location = response.headers.get("location");
			if (location === null || location === "") throw new Error("Registry tarball redirect has no Location");
			current = validateNpmRegistryTarballUrl(new URL(location, current).href, "registry tarball redirect destination");
			continue;
		}
		if (response.url !== "") validateNpmRegistryTarballUrl(response.url, "final registry tarball URL");
		if (!response.ok) throw new Error(`Registry tarball download failed: HTTP ${response.status}`);
		assertContentLengthWithinLimit(response, maxCompressedBytes);
		if (response.body === null) throw new Error("Registry tarball response has no body");

		const chunks: Buffer[] = [];
		let total = 0;
		const reader = response.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value === undefined) throw new Error("Registry tarball stream returned an empty chunk");
				total += value.byteLength;
				if (!Number.isSafeInteger(total) || total > maxCompressedBytes) {
					throw new Error(`Registry tarball compressed size exceeds ${maxCompressedBytes} bytes`);
				}
				chunks.push(Buffer.from(value));
			}
		} finally {
			reader.releaseLock();
		}
		const tarball = Buffer.concat(chunks, total);
		if (sha512Sri(tarball) !== expectedSri) {
			throw new Error("Registry tarball compressed bytes do not match the expected SHA-512 SRI");
		}
		return tarball;
	}
}

async function observeLatestRegistryPackage(record: PackageEvidenceRecord): Promise<{ version: string; dist: { integrity: string; tarball: string } } | undefined> {
	const latestView = await $`npm view ${`${record.name}@${NPM_RELEASE_TAG}`} version dist --json --registry=${NPM_REGISTRY_URL} --tag=${NPM_RELEASE_TAG}`.quiet().nothrow();
	const latestOutput = outputOf(latestView);
	if (latestView.exitCode !== 0) {
		if (isMissingRegistryPackage(latestOutput)) return undefined;
		throw new Error(`npm view failed for stable ${NPM_RELEASE_TAG} ${record.name}: ${latestOutput || `exit ${latestView.exitCode ?? "unknown"}`}`);
	}
	let latestValue: unknown;
	try {
		latestValue = JSON.parse(latestView.stdout.toString()) as unknown;
	} catch {
		throw new Error(`npm view returned invalid latest JSON for ${record.name}`);
	}
	const latest = parseLatestRegistryDist(latestValue, record.name);
	if (compareStableVersions(record.version, latest.version) < 0) {
		throw new Error(`Refusing ${record.name}@${record.version}: current stable ${NPM_RELEASE_TAG} is newer at ${latest.version}`);
	}
	return latest;
}

async function observeRegistryPackage(record: PackageEvidenceRecord, retainedTarball: Buffer): Promise<RegistryPackageObservation | undefined> {
	const specifier = `${record.name}@${record.version}`;
	// Read current latest before target-version absence can authorize any mutation.
	const latest = await observeLatestRegistryPackage(record);
	const view = await $`npm view ${specifier} dist --json --registry=${NPM_REGISTRY_URL} --tag=${NPM_RELEASE_TAG}`.quiet().nothrow();
	const viewOutput = outputOf(view);
	if (view.exitCode !== 0) {
		if (isMissingRegistryPackage(viewOutput)) return undefined;
		throw new Error(`npm view failed for ${specifier}: ${viewOutput || `exit ${view.exitCode ?? "unknown"}`}`);
	}
	if (latest === undefined) throw new Error(`stable ${NPM_RELEASE_TAG} is absent although ${specifier} exists`);
	let distValue: unknown;
	try {
		distValue = JSON.parse(view.stdout.toString()) as unknown;
	} catch {
		throw new Error(`npm view returned invalid JSON for ${specifier}`);
	}
	const dist = parseRegistryDist(distValue, specifier);
	if (dist.integrity !== record.expected_sri) {
		throw new Error(`npm view integrity for ${specifier} conflicts with immutable expected evidence`);
	}
	if (latest.version !== record.version || latest.dist.integrity !== dist.integrity || latest.dist.tarball !== dist.tarball) {
		throw new Error(`stable ${NPM_RELEASE_TAG} for ${record.name} does not identify immutable expected evidence`);
	}

	const registryTarball = await downloadNpmRegistryTarball(dist.tarball, record.expected_sri);
	const retainedInspection = inspectPackageTarball(retainedTarball);
	const registryInspection = inspectPackageTarball(registryTarball);
	if (!retainedInspection.manifestBytes.equals(registryInspection.manifestBytes)) {
		throw new Error(`Registry package/package.json bytes conflict with retained evidence for ${specifier}`);
	}
	const observation: RegistryPackageObservation = {
		registry_sri: dist.integrity,
		registry_tarball_sha512: createHash("sha512").update(registryTarball).digest("hex"),
		registry_manifest_sha256: createHash("sha256").update(registryInspection.manifestBytes).digest("hex"),
		registry_internal_dependencies: registryInspection.manifest.internalDependencies,
		registry_latest_version: latest.version,
	};
	const status = classifyRegistryObservation(record, observation);
	if (status === "conflict") throw new Error(`Published ${specifier} conflicts with immutable expected evidence; release a newer version`);
	return observation;
}

export async function readRetainedTarball(record: PackageEvidenceRecord, tarballPath: string): Promise<Buffer> {
	let retainedFile: fs.FileHandle;
	try {
		retainedFile = await fs.open(tarballPath, "r");
	} catch (error) {
		if (isMissingFile(error)) {
			throw new Error(
				`Retained tarball for ${record.name}@${record.version} is missing or expired; rerun --prepare-evidence and continue only if immutable expected evidence reproduces exactly`,
			);
		}
		throw error;
	}
	try {
		const metadata = await retainedFile.stat();
		if (!metadata.isFile()) throw new Error(`Retained tarball for ${record.name}@${record.version} is not a regular file`);
		if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > RELEASE_TARBALL_LIMITS.maxCompressedBytes) {
			throw new Error(`Retained tarball for ${record.name}@${record.version} compressed size exceeds ${RELEASE_TARBALL_LIMITS.maxCompressedBytes} bytes`);
		}
		const retainedTarball = Buffer.allocUnsafe(metadata.size);
		let offset = 0;
		while (offset < retainedTarball.length) {
			const { bytesRead } = await retainedFile.read(retainedTarball, offset, retainedTarball.length - offset, offset);
			if (bytesRead === 0) throw new Error(`Retained tarball for ${record.name}@${record.version} changed while it was read`);
			offset += bytesRead;
		}
		const trailingByte = Buffer.alloc(1);
		const { bytesRead: trailingBytes } = await retainedFile.read(trailingByte, 0, 1, retainedTarball.length);
		if (trailingBytes !== 0) throw new Error(`Retained tarball for ${record.name}@${record.version} grew while it was read`);
		validateExpectedTarball(record, retainedTarball);
		return retainedTarball;
	} finally {
		await retainedFile.close();
	}
}

function assertExactRegistryObservation(record: PackageEvidenceRecord, observation: RegistryPackageObservation): void {
	const latestVersion = observation.registry_latest_version;
	if (latestVersion === undefined) {
		throw new Error(`Registry latest observation is missing for ${record.name}@${record.version}`);
	}
	assertMonotonicLatestVersion(record.version, latestVersion, `stable ${NPM_RELEASE_TAG} for ${record.name}`);
	if (latestVersion !== record.version || classifyRegistryObservation(record, observation) !== "skip") {
		throw new Error(`Published ${record.name}@${record.version} conflicts with immutable expected evidence; release a newer version`);
	}
}

interface PublishAttempt {
	exitCode: number | null;
	output: string;
}

interface PublishRetainedPackageOperations {
	readTarball(record: PackageEvidenceRecord, tarballPath: string): Promise<Buffer>;
	observe(record: PackageEvidenceRecord, retainedTarball: Buffer): Promise<RegistryPackageObservation | undefined>;
	publish(tarballPath: string): Promise<PublishAttempt>;
}

export async function publishRetainedPackage(
	record: PackageEvidenceRecord,
	tarballPath: string,
	operations: PublishRetainedPackageOperations = {
		readTarball: readRetainedTarball,
		observe: observeRegistryPackage,
		publish: async (candidateTarballPath) => {
			const result = await $`npm publish ${candidateTarballPath} --access public --registry=${NPM_REGISTRY_URL} --tag=${NPM_RELEASE_TAG}`.quiet().nothrow();
			return { exitCode: result.exitCode, output: outputOf(result) };
		},
	},
): Promise<RegistryPackageObservation> {
	const retainedTarball = await operations.readTarball(record, tarballPath);
	validateExpectedTarball(record, retainedTarball);

	const existing = await operations.observe(record, retainedTarball);
	if (existing !== undefined) {
		assertExactRegistryObservation(record, existing);
		console.log(`Skipping ${record.name}@${record.version} (registry bytes match expected evidence)`);
		return existing;
	}
	console.log(`Publishing retained ${record.name}@${record.version}…`);
	const publish = await operations.publish(tarballPath);
	if (publish.exitCode !== 0) {
		const raced = await operations.observe(record, retainedTarball);
		if (raced !== undefined) {
			assertExactRegistryObservation(record, raced);
			console.log(`Skipping ${record.name}@${record.version} (concurrent exact publication)`);
			return raced;
		}
		throw new Error(`npm publish failed for ${record.name}@${record.version}: ${publish.output || `exit ${publish.exitCode ?? "unknown"}`}`);
	}
	const observed = await operations.observe(record, retainedTarball);
	if (observed === undefined) throw new Error(`Registry did not expose ${record.name}@${record.version} after publish`);
	assertExactRegistryObservation(record, observed);
	return observed;
}

export function planExpectedEvidencePublication(records: readonly PackageEvidenceRecord[]): PackageEvidenceRecord[] {
	assertPublishConfiguration();
	const recordsByName = new Map<string, PackageEvidenceRecord>();
	for (const record of records) {
		if (recordsByName.has(record.name)) {
			throw new Error(`Expected evidence contains duplicate package record ${record.name}`);
		}
		recordsByName.set(record.name, record);
	}

	const definitionsByDir = new Map(PUBLIC_PACKAGE_DEFINITIONS.map(definition => [definition.dir, definition]));
	const declaredNames = new Set<string>();
	const unmatchedRecords = new Map(recordsByName);
	const declaredRecords: PackageEvidenceRecord[] = [];
	for (const pkg of packages) {
		const definition = definitionsByDir.get(pkg.dir);
		if (definition === undefined) throw new Error(`No evidence definition exists for ${pkg.dir}`);
		if (declaredNames.has(definition.name)) {
			throw new Error(`Publish configuration declares duplicate package ${definition.name}`);
		}
		declaredNames.add(definition.name);
		const record = recordsByName.get(definition.name);
		if (record === undefined) {
			throw new Error(`Expected evidence is missing package record ${definition.name} for ${pkg.dir}`);
		}
		if (record.dir !== pkg.dir) {
			throw new Error(`Expected evidence record ${record.name} has dir ${record.dir}; expected ${pkg.dir}`);
		}
		declaredRecords.push(record);
		unmatchedRecords.delete(definition.name);
	}
	if (unmatchedRecords.size > 0) {
		throw new Error(`Expected evidence contains unexpected package record(s): ${[...unmatchedRecords.keys()].sort().join(", ")}`);
	}

	const releaseVersion = declaredRecords[0]?.version;
	if (releaseVersion === undefined) throw new Error("Expected evidence contains no package records");
	if (declaredRecords.some(record => record.version !== releaseVersion)) {
		throw new Error("Expected evidence package records must share one exact release version");
	}
	const declarationIndex = new Map(declaredRecords.map((record, index) => [record.name, index]));
	const indegree = new Map(declaredRecords.map(record => [record.name, 0]));
	const dependents = new Map(declaredRecords.map(record => [record.name, [] as string[]]));
	for (const record of declaredRecords) {
		assertExactInternalReleaseDependencies(record.internal_dependencies, releaseVersion, `Expected evidence record ${record.name}`);
		for (const dependencyName of Object.keys(record.internal_dependencies).sort()) {
			if (!recordsByName.has(dependencyName)) {
				throw new Error(`Expected evidence record ${record.name} depends on absent internal package ${dependencyName}`);
			}
			indegree.set(record.name, (indegree.get(record.name) ?? 0) + 1);
			dependents.get(dependencyName)!.push(record.name);
		}
	}

	const ready = declaredRecords.filter(record => indegree.get(record.name) === 0);
	const ordered: PackageEvidenceRecord[] = [];
	while (ready.length > 0) {
		ready.sort((left, right) => declarationIndex.get(left.name)! - declarationIndex.get(right.name)!);
		const next = ready.shift()!;
		ordered.push(next);
		for (const dependentName of dependents.get(next.name)!) {
			const remaining = (indegree.get(dependentName) ?? 0) - 1;
			indegree.set(dependentName, remaining);
			if (remaining === 0) ready.push(recordsByName.get(dependentName)!);
		}
	}
	if (ordered.length !== declaredRecords.length) {
		const cycle = declaredRecords
			.filter(record => (indegree.get(record.name) ?? 0) > 0)
			.map(record => record.name)
			.join(", ");
		throw new Error(`Expected evidence internal dependency graph contains a cycle: ${cycle}`);
	}
	return ordered;
}

export async function publishExpectedEvidencePackages<T>(
	records: readonly PackageEvidenceRecord[],
	publishRecord: (record: PackageEvidenceRecord) => Promise<T>,
): Promise<Record<string, T>> {
	const observations: Record<string, T> = {};
	for (const record of planExpectedEvidencePublication(records)) {
		observations[record.name] = await publishRecord(record);
	}
	return observations;
}

/** Re-reads every target after all publishes so stale resume observations cannot finalize evidence. */
export async function reobserveExpectedEvidencePackages(
	records: readonly PackageEvidenceRecord[],
	observeRecord: (record: PackageEvidenceRecord) => Promise<RegistryPackageObservation | undefined>,
): Promise<Record<string, RegistryPackageObservation>> {
	const observations: Record<string, RegistryPackageObservation> = {};
	for (const record of planExpectedEvidencePublication(records)) {
		const observation = await observeRecord(record);
		if (observation === undefined) throw new Error(`Registry did not expose ${record.name}@${record.version} during final evidence sweep`);
		assertExactRegistryObservation(record, observation);
		observations[record.name] = observation;
	}
	return observations;
}


/**
 * The caller must hold the same external serialization guard for every stable
 * npm release. Version-scoped guards are rejected because they cannot prevent
 * two releases from racing the shared npm latest tag.
 */
export function assertReleaseSerializationGuard(releaseSerializationKey: string, releaseVersion: string): void {
	if (!releaseSerializationKeyPattern.test(releaseSerializationKey)) {
		throw new Error("Release serialization guard must be a non-empty shared cross-version key");
	}
	if (releaseSerializationKey.includes(releaseVersion)) {
		throw new Error(`Release serialization guard ${releaseSerializationKey} must not be scoped to release version ${releaseVersion}`);
	}
}

async function publishFromExpectedEvidence(evidenceDirectory: string, releaseSerializationKey: string): Promise<void> {
	assertPublishConfiguration();
	await assertPinnedNpmConfiguration();
	const expectedPath = path.join(evidenceDirectory, EXPECTED_EVIDENCE_FILE);
	const expectedAsset = await readExpectedEvidenceFile(expectedPath);
	assertReleaseSerializationGuard(releaseSerializationKey, expectedAsset.value.release_version);
	await publishExpectedEvidencePackages(expectedAsset.value.packages, async (record) => {
		const tarballPath = path.join(evidenceDirectory, "tarballs", `${record.tarball_sha512}.tgz`);
		return publishRetainedPackage(record, tarballPath);
	});
	const observations = await reobserveExpectedEvidencePackages(expectedAsset.value.packages, async (record) => {
		const tarballPath = path.join(evidenceDirectory, "tarballs", `${record.tarball_sha512}.tgz`);
		return observeRegistryPackage(record, await readRetainedTarball(record, tarballPath));
	});
	const final = createFinalEvidence(expectedAsset.value, expectedAsset.sha256, observations);
	const finalPath = path.join(evidenceDirectory, FINAL_EVIDENCE_FILE);
	const finalDigest = await writeImmutableEvidence(finalPath, final);
	console.log(JSON.stringify({
		ok: true,
		phase: "final-evidence",
		expected_evidence: expectedPath,
		expected_evidence_sha256: expectedAsset.sha256,
		final_evidence: finalPath,
		final_evidence_sha256: finalDigest,
		verified_packages: final.packages.length,
	}));
}

async function dryRun(): Promise<void> {
	isDryRun = true;
	try {
		for (const pkg of packages) {
			const manifest = await readPackageManifest(path.join(repoRoot, pkg.dir));
			const name = manifest.name ?? path.basename(pkg.dir);
			if (manifest.private) {
				console.log(`Skipping ${name} (private)`);
				continue;
			}
			if (pkg.kind === "native-platform") await stageNativePlatformArtifacts(pkg);
			console.log(`DRY RUN npm publish --access public (${pkg.dir})`);
		}
	} finally {
		isDryRun = false;
	}
}

async function main(): Promise<void> {
	const command = parseReleasePublishCli(process.argv.slice(2));
	if (command.mode === "evidence-self-test") {
		releaseEvidenceSelfTest();
		console.log(JSON.stringify({ ok: true, phase: "evidence-self-test" }));
		return;
	}
	if (command.mode === "check-types") {
		await checkTypeDeclarations();
		return;
	}
	if (command.mode === "dry-run") {
		await dryRun();
		return;
	}
	await checkTypeDeclarations();
	if (command.mode === "prepare-evidence") {
		await prepareExpectedEvidence(command.evidenceDir);
		return;
	}
	await publishFromExpectedEvidence(command.evidenceDir, command.releaseSerializationKey);
}

if (import.meta.main) {
	await main();
}
