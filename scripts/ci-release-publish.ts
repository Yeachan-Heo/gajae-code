#!/usr/bin/env bun
/**
 * Publish workspace packages.
 *
 * For each public TypeScript package we:
 *   1. Emit `.d.ts` declarations into `dist/types/` so consumers get
 *      stable types regardless of their tsconfig `lib`.
 *   2. Rewrite `package.json` in place — every `types`/`exports[*].types`
 *      that points at `./src/*.ts(x)` is repointed to `./dist/types/*.d.ts`
 *      and `dist/types` (plus `dist/client` for `stats`) is added to
 *      `files`. The on-repo manifest keeps pointing at source so local
 *      dev resolves types without any build.
 *   3. Invoke `bun publish` on the (now publish-shaped) manifest.
 *
 * Intended for CI. Mutates `package.json` in place — if you run this
 * locally, expect a dirty working tree and `git restore` after.
 */

import * as path from "node:path";
import { $ } from "bun";

interface PublishPackage {
	dir: string;
	kind: "typescript" | "native" | "manifest";
	/** Extra build steps before manifest rewrite (e.g. esbuild bundles). */
	preBuild?: readonly (readonly string[])[];
	/** Extra entries to splice into `files`. */
	extraFiles?: readonly string[];
	/** Extra tsgo invocations beyond `tsconfig.publish.json`. */
	extraTypeConfigs?: readonly string[];
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
	[key: string]: JsonValue;
}
interface PackageManifest extends JsonObject {
	name?: string;
	version?: string;
	private?: boolean;
}

const repoRoot = path.join(import.meta.dir, "..");
const isDryRun = process.argv.includes("--dry-run");
export const packages: PublishPackage[] = [
	{ dir: "packages/utils", kind: "typescript" },
	{ dir: "packages/ai", kind: "typescript" },
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
	{ dir: "packages/bridge-client", kind: "typescript" },
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

async function preparePackage(pkg: PublishPackage): Promise<PackageManifest> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	if (pkg.kind === "native" || pkg.kind === "manifest") {
		return rewriteNativeManifest(pkgDir);
	}
	for (const argv of pkg.preBuild ?? []) {
		await $`${argv}`.cwd(pkgDir);
	}
	await $`bun x tsgo -p tsconfig.publish.json`.cwd(pkgDir);
	for (const cfg of pkg.extraTypeConfigs ?? []) {
		await $`bun x tsgo -p ${cfg}`.cwd(pkgDir);
	}
	return rewriteManifest(pkgDir, pkg.extraFiles ?? []);
}

async function publishPackage(pkg: PublishPackage): Promise<void> {
	const pkgDir = path.join(repoRoot, pkg.dir);
	const manifest = await preparePackage(pkg);
	const name = manifest.name ?? path.basename(pkg.dir);
	if (manifest.private) {
		console.log(`Skipping ${name} (private)`);
		return;
	}
	const version = typeof manifest.version === "string" ? manifest.version : undefined;
	if (!isDryRun && version !== undefined) {
		const existing = await $`npm view ${`${name}@${version}`} version --json`.quiet().nothrow();
		if (existing.exitCode === 0) {
			console.log(`Skipping ${name}@${version} (already published)`);
			return;
		}
	}
	if (isDryRun) {
		console.log(`DRY RUN npm publish --access public (${pkg.dir})`);
		return;
	}
	console.log(`Publishing ${name}…`);
	const result = await $`npm publish --access public`.cwd(pkgDir).quiet().nothrow();
	const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
	if (output) console.log(output);
	if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

async function main(): Promise<void> {
	for (const pkg of packages) {
		await publishPackage(pkg);
	}
}

if (import.meta.main) {
	await main();
}
