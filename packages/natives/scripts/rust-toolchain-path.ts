import * as path from "node:path";
import { $ } from "bun";

export type CargoToolchainPathSource = "rustup" | "path";

export type CargoToolchainPathResolution = {
	cargoBinary: string;
	toolchainBin: string;
	pathValue: string;
	source: CargoToolchainPathSource;
};

export function prependPathEntry(currentPath: string, entry: string, separator: string): string {
	const existingEntries = currentPath.split(separator).filter(Boolean);
	const dedupedEntries = existingEntries.filter(existingEntry => existingEntry !== entry);
	return [entry, ...dedupedEntries].join(separator);
}

export function resolveCargoToolchainPathFromCandidates(options: {
	currentPath: string;
	pathSeparator: string;
	pathCargoBinary: string | null;
	rustupCargoBinary: string | null;
}): CargoToolchainPathResolution | null {
	const rustupCargoBinary = options.rustupCargoBinary?.trim() || null;
	const pathCargoBinary = options.pathCargoBinary?.trim() || null;
	const cargoBinary = rustupCargoBinary ?? pathCargoBinary;
	if (!cargoBinary) return null;

	const source: CargoToolchainPathSource = rustupCargoBinary ? "rustup" : "path";
	const toolchainBin = path.dirname(cargoBinary);
	return {
		cargoBinary,
		toolchainBin,
		pathValue: prependPathEntry(options.currentPath, toolchainBin, options.pathSeparator),
		source,
	};
}

async function resolveRustupCargoBinary(cwd: string): Promise<string | null> {
	const rustupBinary = Bun.which("rustup");
	if (!rustupBinary) return null;

	const result = await $`${rustupBinary} which cargo`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) return null;

	const cargoBinary = result.stdout.toString("utf-8").trim();
	return cargoBinary === "" ? null : cargoBinary;
}

export async function resolveCargoToolchainPath(options: {
	cwd: string;
	currentPath: string;
}): Promise<CargoToolchainPathResolution | null> {
	const pathSeparator = process.platform === "win32" ? ";" : ":";
	const rustupCargoBinary = await resolveRustupCargoBinary(options.cwd);
	const pathCargoBinary = Bun.which("cargo", { PATH: options.currentPath }) ?? null;
	return resolveCargoToolchainPathFromCandidates({
		currentPath: options.currentPath,
		pathSeparator,
		pathCargoBinary,
		rustupCargoBinary,
	});
}
