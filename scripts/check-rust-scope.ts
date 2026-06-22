#!/usr/bin/env bun

/**
 * Guardrail for the repo's Rust boundary.
 *
 * Rust is reserved for native bindings, native OS/process/filesystem integration,
 * or measured hot paths. This check intentionally fails when a new crate or Rust
 * source tree appears without an explicit rationale in RUST_SCOPE_ALLOWLIST.
 */

import * as path from "node:path";
import { Glob } from "bun";

interface RustScopeEntry {
	/** Directory relative to the repository root. */
	dir: string;
	/** Package name from Cargo.toml when the directory is a crate. */
	packageName?: string;
	/** Why this Rust surface is allowed under the native/performance policy. */
	rationale: string;
}

const repoRoot = path.join(import.meta.dir, "..");

const RUST_SCOPE_ALLOWLIST: readonly RustScopeEntry[] = [
	{
		dir: "crates/pi-natives",
		packageName: "pi-natives",
		rationale: "N-API addon boundary for native, CPU-bound, blocking I/O, and OS integration primitives.",
	},
	{
		dir: "crates/pi-shell",
		packageName: "pi-shell",
		rationale: "Embedded shell, PTY, and process-management runtime used behind native bindings.",
	},
	{
		dir: "crates/pi-ast",
		packageName: "pi-ast",
		rationale: "Tree-sitter parsing and summarization hot paths shared by native code.",
	},
	{
		dir: "crates/pi-iso",
		packageName: "pi-iso",
		rationale: "Native filesystem isolation backends such as clone, reflink, overlay, and ProjFS.",
	},
	{
		dir: "crates/gjc-notifications",
		packageName: "gjc-notifications",
		rationale: "Notifications SDK Rust core for loopback WebSocket transport, endpoint discovery, and planned N-API integration.",
	},
	{
		dir: "crates/brush-core-vendored",
		packageName: "brush-core",
		rationale: "Vendored Rust shell runtime dependency for the native shell boundary.",
	},
	{
		dir: "crates/brush-builtins-vendored",
		packageName: "brush-builtins",
		rationale: "Vendored Rust shell builtin dependency for the native shell boundary.",
	},
] as const;

const ALLOWED_NON_CRATE_RUST_FILES = new Set(["packages/coding-agent/test/fixtures/chunk-edit-indent.rs"]);

const allowlistByDir = new Map(RUST_SCOPE_ALLOWLIST.map(entry => [entry.dir, entry]));
const allowlistByPackage = new Map(
	RUST_SCOPE_ALLOWLIST.flatMap(entry => (entry.packageName ? ([[entry.packageName, entry] as const] satisfies readonly [string, RustScopeEntry][]) : [])),
);

const errors: string[] = [];

const crateFiles = await collectRelativeMatches("crates/*/Cargo.toml");
for (const cargoTomlPath of crateFiles) {
	const crateDir = path.posix.dirname(cargoTomlPath);
	const packageName = await readPackageName(cargoTomlPath);
	const allowlistEntry = allowlistByDir.get(crateDir);

	if (!allowlistEntry) {
		errors.push(`Rust crate is not allowlisted: ${crateDir}${packageName ? ` (${packageName})` : ""}`);
		continue;
	}

	if (allowlistEntry.packageName && packageName !== allowlistEntry.packageName) {
		errors.push(
			`Rust crate package mismatch for ${crateDir}: expected ${allowlistEntry.packageName}, found ${packageName ?? "<missing>"}`,
		);
	}
}

for (const entry of RUST_SCOPE_ALLOWLIST) {
	if (!entry.rationale.trim()) {
		errors.push(`Rust allowlist entry has no rationale: ${entry.dir}`);
	}
	if (entry.packageName && !allowlistByPackage.has(entry.packageName)) {
		errors.push(`Rust allowlist package index is missing: ${entry.packageName}`);
	}
}

const rustSourceFiles = await collectRelativeMatches("**/*.rs");
for (const rustSourceFile of rustSourceFiles) {
	if (isIgnoredPath(rustSourceFile)) continue;
	if (ALLOWED_NON_CRATE_RUST_FILES.has(rustSourceFile)) continue;
	if (isUnderAllowedRustDir(rustSourceFile)) continue;
	errors.push(`Rust source is outside allowed native/performance-critical directories: ${rustSourceFile}`);
}

if (errors.length > 0) {
	console.error("Rust scope check failed. Rust is limited to native/performance-critical parts:");
	for (const error of errors) {
		console.error(`- ${error}`);
	}
	console.error("\nUpdate RUST_SCOPE_ALLOWLIST only when the new Rust surface has a native/performance rationale.");
	process.exit(1);
}

console.log("Rust scope check passed:");
for (const entry of RUST_SCOPE_ALLOWLIST) {
	console.log(`- ${entry.dir}: ${entry.rationale}`);
}
if (ALLOWED_NON_CRATE_RUST_FILES.size > 0) {
	console.log(`- ${ALLOWED_NON_CRATE_RUST_FILES.size} non-crate Rust fixture(s) allowed for tests only.`);
}

async function collectRelativeMatches(pattern: string): Promise<string[]> {
	const glob = new Glob(pattern);
	const matches: string[] = [];
	for await (const match of glob.scan({ cwd: repoRoot, dot: true, onlyFiles: true })) {
		matches.push(normalizePath(match));
	}
	return matches.sort();
}

async function readPackageName(cargoTomlPath: string): Promise<string | undefined> {
	const text = await Bun.file(path.join(repoRoot, cargoTomlPath)).text();
	let inPackageSection = false;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "[package]") {
			inPackageSection = true;
			continue;
		}
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			inPackageSection = false;
			continue;
		}
		if (!inPackageSection) continue;
		const match = /^name\s*=\s*"([^"]+)"/.exec(trimmed);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

function isIgnoredPath(relativePath: string): boolean {
	return (
		relativePath.startsWith(".git/") ||
		relativePath.startsWith(".gjc/") ||
		relativePath.startsWith(".worktrees/") ||
		relativePath.startsWith(".wt/") ||
		relativePath.startsWith("node_modules/") ||
		relativePath.includes("/node_modules/") ||
		relativePath.startsWith("target/") ||
		relativePath.includes("/target/")
	);
}

function isUnderAllowedRustDir(relativePath: string): boolean {
	return RUST_SCOPE_ALLOWLIST.some(entry => relativePath === entry.dir || relativePath.startsWith(`${entry.dir}/`));
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "");
}
