#!/usr/bin/env bun
/**
 * Rust porting inventory verifier.
 *
 * `--deps`: every dependency present in both the local root `[workspace.dependencies]`
 * and the pinned upstream snapshot must share the exact version requirement, and the
 * local feature list must be a superset of upstream's (minus explicitly excluded
 * upstream-only features).
 */
import * as path from "node:path";

export const INVENTORY_PATH = "docs/rust-porting-inventory.md";
const PIN_PATTERN = /^Upstream pin: `can1357\/oh-my-pi@([0-9a-f]{40})`$/m;

/** Upstream features gjc intentionally does not enable (audio stack rejected as pi-voice). */
export const EXCLUDED_UPSTREAM_FEATURES: Readonly<Record<string, readonly string[]>> = {
	"windows-sys": ["Win32_Media_Audio", "Win32_Media_Multimedia"],
};

type DependencySpec = string | { version?: string; features?: string[] };

export interface DepsMismatch {
	name: string;
	reason: "version" | "features";
	local: string;
	upstream: string;
}

function specVersion(spec: DependencySpec): string {
	return typeof spec === "string" ? spec : (spec.version ?? "");
}

function specFeatures(spec: DependencySpec): string[] {
	return typeof spec === "string" ? [] : (spec.features ?? []);
}

export function workspaceDependencies(toml: string): Record<string, DependencySpec> {
	const parsed = Bun.TOML.parse(toml) as { workspace?: { dependencies?: Record<string, DependencySpec> } };
	const deps = parsed.workspace?.dependencies;
	if (!deps) throw new Error("missing [workspace.dependencies] table");
	return deps;
}

export function parsePin(inventory: string): string {
	const match = inventory.match(PIN_PATTERN);
	if (!match) throw new Error(`${INVENTORY_PATH} is missing the "Upstream pin" header line`);
	return match[1];
}

export function snapshotPathForPin(pin: string): string {
	return `docs/rust-porting/upstream-workspace-deps@${pin.slice(0, 8)}.toml`;
}

export function compareWorkspaceDeps(
	local: Record<string, DependencySpec>,
	upstream: Record<string, DependencySpec>,
): DepsMismatch[] {
	const mismatches: DepsMismatch[] = [];
	for (const name of Object.keys(upstream).sort()) {
		const localSpec = local[name];
		if (localSpec === undefined) continue;
		const upstreamSpec = upstream[name];
		const localVersion = specVersion(localSpec);
		const upstreamVersion = specVersion(upstreamSpec);
		if (localVersion !== upstreamVersion) {
			mismatches.push({ name, reason: "version", local: localVersion, upstream: upstreamVersion });
			continue;
		}
		const excluded = EXCLUDED_UPSTREAM_FEATURES[name] ?? [];
		const localFeatures = new Set(specFeatures(localSpec));
		const missing = specFeatures(upstreamSpec).filter(
			feature => !localFeatures.has(feature) && !excluded.includes(feature),
		);
		if (missing.length > 0) {
			mismatches.push({
				name,
				reason: "features",
				local: [...localFeatures].sort().join(","),
				upstream: `missing ${missing.join(",")}`,
			});
		}
	}
	return mismatches;
}

async function runDeps(repoRoot: string): Promise<number> {
	const pin = parsePin(await Bun.file(path.join(repoRoot, INVENTORY_PATH)).text());
	const snapshotPath = snapshotPathForPin(pin);
	const snapshot = Bun.file(path.join(repoRoot, snapshotPath));
	if (!(await snapshot.exists())) {
		process.stderr.write(`missing upstream snapshot ${snapshotPath} for pin ${pin}\n`);
		return 1;
	}
	const mismatches = compareWorkspaceDeps(
		workspaceDependencies(await Bun.file(path.join(repoRoot, "Cargo.toml")).text()),
		workspaceDependencies(await snapshot.text()),
	);
	if (mismatches.length === 0) {
		process.stdout.write(`workspace deps match upstream pin ${pin}\n`);
		return 0;
	}
	for (const mismatch of mismatches) {
		process.stderr.write(`${mismatch.name}: ${mismatch.reason} local=${mismatch.local} upstream=${mismatch.upstream}\n`);
	}
	return 1;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const repoRoot = path.resolve(import.meta.dir, "..");
	if (args.length === 1 && args[0] === "--deps") {
		process.exit(await runDeps(repoRoot));
	}
	process.stderr.write("usage: bun scripts/verify-rust-porting-inventory.ts --deps\n");
	process.exit(2);
}
