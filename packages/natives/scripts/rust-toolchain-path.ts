import * as os from "node:os";
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

export function dedupeOrderedPaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const candidate of paths) {
		const normalized = candidate.trim();
		if (normalized === "" || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}

	return result;
}

export function resolveRustupCandidatePaths(options: {
	currentPath: string;
	cargoHome?: string;
	homeDir: string;
}): string[] {
	const explicitPathRustup = Bun.which("rustup", { PATH: options.currentPath });
	const cargoHome = options.cargoHome?.trim() || null;
	const defaultCargoHome = path.join(options.homeDir, ".cargo");

	return dedupeOrderedPaths([
		explicitPathRustup ?? "",
		cargoHome ? path.join(cargoHome, "bin", process.platform === "win32" ? "rustup.exe" : "rustup") : "",
		path.join(defaultCargoHome, "bin", process.platform === "win32" ? "rustup.exe" : "rustup"),
	]);
}

async function resolveRustupCargoBinary(cwd: string, rustupCandidates: readonly string[]): Promise<string | null> {
	for (const rustupBinary of rustupCandidates) {
		const result = await $`${rustupBinary} which cargo`.cwd(cwd).quiet().nothrow();
		if (result.exitCode !== 0) continue;

		const cargoBinary = result.stdout.toString("utf-8").trim();
		if (cargoBinary !== "") return cargoBinary;
	}
	return null;
}

export async function resolveCargoToolchainPath(options: {
	cwd: string;
	currentPath: string;
}): Promise<CargoToolchainPathResolution | null> {
	const pathSeparator = process.platform === "win32" ? ";" : ":";
	const rustupCargoBinary = await resolveRustupCargoBinary(
		options.cwd,
		resolveRustupCandidatePaths({
			currentPath: options.currentPath,
			cargoHome: Bun.env.CARGO_HOME,
			homeDir: os.homedir(),
		}),
	);
	const pathCargoBinary = Bun.which("cargo", { PATH: options.currentPath }) ?? null;
	return resolveCargoToolchainPathFromCandidates({
		currentPath: options.currentPath,
		pathSeparator,
		pathCargoBinary,
		rustupCargoBinary,
	});
}
