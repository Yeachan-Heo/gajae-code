#!/usr/bin/env bun
/**
 * Guard: no file Biome processes may exceed Biome's `files.maxSize`.
 *
 * Biome does not fail on a file above `files.maxSize`. It skips the file and
 * prints a size warning, so the file silently loses lint and format coverage.
 * `packages/coding-agent/src/session/agent-session.ts` went unlinted that way
 * once it crossed the 1 MiB default.
 *
 * This check lists the files Biome would process (tracked plus untracked,
 * non-ignored files, matching Biome's VCS ignore integration) and fails when
 * any of them reaches the limit that applies to it. Biome skips a file whose
 * size is greater than or equal to `files.maxSize`, so a file exactly at the
 * limit already fails here. The limit comes from these settings:
 *
 * - The root `biome.json` must set `files.maxSize` explicitly so the 1 MiB
 *   default cannot return unnoticed. Its `files.includes` selects the files.
 * - A nested `biome.json` (`"root": false`) owns the files under its directory,
 *   with its own `files.includes` and `files.maxSize` (inherited from the root
 *   only when it extends `"//"`, otherwise Biome's 1 MiB default).
 * - A matching `overrides[].files.maxSize` takes precedence, as in Biome.
 *
 * A file that must stay unlinted has to be excluded explicitly with a negated
 * `files.includes` pattern, which this check honours.
 */
import { $ } from "bun";
import * as path from "node:path";

/** Biome's built-in `files.maxSize` (1 MiB). */
export const BIOME_DEFAULT_MAX_SIZE = 1024 * 1024;

const CONFIG_FILE_NAMES = new Set(["biome.json", "biome.jsonc"]);
// File kinds Biome handles; used when a config has no `files.includes`, in
// which case Biome processes every supported file under its directory.
const BIOME_SUPPORTED_FILE = /\.(?:[cm]?[jt]sx?|jsonc?|css|graphql|gql|html|vue|svelte|astro|grit)$/;

export interface BiomeSizeSettings {
	maxSize: number;
	includes: string[];
	overrides: { includes: string[]; maxSize: number }[];
}

export interface BiomeConfigScope {
	/** Repository-relative directory of the config; "" for the root. */
	dir: string;
	/** Repository-relative path of the config file itself. */
	configPath: string;
	settings: BiomeSizeSettings;
}

export interface OversizedFile {
	/** Repository-relative path. */
	path: string;
	size: number;
	limit: number;
	/** Repository-relative path of the `biome.json` that sets the limit. */
	config: string;
}

export interface BiomeMaxSizeResult {
	rootMaxSize: number;
	checkedFiles: number;
	oversized: OversizedFile[];
}

export interface CheckBiomeMaxSizeOptions {
	/** Repository root that holds the root `biome.json`. */
	root: string;
	/** Lists repository-relative candidate paths. Defaults to `git ls-files`. */
	listFiles?: (root: string) => Promise<string[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIncludes(value: unknown, where: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every(entry => typeof entry === "string")) {
		throw new Error(`${where} must be an array of glob strings`);
	}
	return value;
}

function readMaxSize(value: unknown, where: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${where} must be a positive integer byte count`);
	}
	return value;
}

function extendsRoot(config: Record<string, unknown>): boolean {
	return config.extends === "//" || (Array.isArray(config.extends) && config.extends.includes("//"));
}

/**
 * Extracts the size-relevant settings from the text of a `biome.json`.
 * `inheritedMaxSize` is the limit used when the config sets none; pass
 * `undefined` for the root config, which must set `files.maxSize` itself.
 */
export function parseBiomeSizeSettings(
	configText: string,
	options: { configPath: string; rootMaxSize?: number },
): BiomeSizeSettings {
	const config: unknown = Bun.JSON5.parse(configText);
	const where = options.configPath;
	if (!isRecord(config)) throw new Error(`${where} must contain an object`);
	const files = isRecord(config.files) ? config.files : {};
	const ownMaxSize = readMaxSize(files.maxSize, `${where} files.maxSize`);
	let maxSize: number;
	if (ownMaxSize !== undefined) {
		maxSize = ownMaxSize;
	} else if (options.rootMaxSize === undefined) {
		throw new Error(
			`${where} must set files.maxSize explicitly; without it Biome falls back to 1 MiB and silently skips larger files`,
		);
	} else {
		maxSize = extendsRoot(config) ? options.rootMaxSize : BIOME_DEFAULT_MAX_SIZE;
	}
	const overrides: BiomeSizeSettings["overrides"] = [];
	const rawOverrides = Array.isArray(config.overrides) ? config.overrides : [];
	rawOverrides.forEach((override, index) => {
		if (!isRecord(override) || !isRecord(override.files)) return;
		const overrideMaxSize = readMaxSize(override.files.maxSize, `${where} overrides[${index}].files.maxSize`);
		if (overrideMaxSize === undefined) return;
		overrides.push({
			includes: readIncludes(override.includes, `${where} overrides[${index}].includes`),
			maxSize: overrideMaxSize,
		});
	});
	return { maxSize, includes: readIncludes(files.includes, `${where} files.includes`), overrides };
}

/**
 * Evaluates a Biome `includes` list for one path relative to the config
 * directory. Patterns apply in order and the last matching one wins; a leading
 * `!` (or `!!`) negates. An empty list includes every supported file.
 */
export function matchesBiomeIncludes(relativePath: string, includes: readonly string[]): boolean {
	if (includes.length === 0) return BIOME_SUPPORTED_FILE.test(relativePath);
	let included = false;
	for (const pattern of includes) {
		const negated = pattern.startsWith("!");
		const glob = pattern.replace(/^!{1,2}/, "");
		if (new Bun.Glob(glob).match(relativePath)) included = !negated;
	}
	return included;
}

/**
 * Returns the size limit Biome applies to a path: the last matching override,
 * else the config limit. Biome applies no override that lacks `includes`, so an
 * empty list never matches here (unlike `files.includes`, where it means all).
 */
export function effectiveMaxSize(relativePath: string, settings: BiomeSizeSettings): number {
	let limit = settings.maxSize;
	for (const override of settings.overrides) {
		if (override.includes.length > 0 && matchesBiomeIncludes(relativePath, override.includes))
			limit = override.maxSize;
	}
	return limit;
}

function configDir(configPath: string): string {
	const dir = path.posix.dirname(configPath);
	return dir === "." ? "" : dir;
}

/** The nearest config at or above the file's directory owns the file. */
function owningScope(relativePath: string, scopes: readonly BiomeConfigScope[]): BiomeConfigScope {
	let owner = scopes[0];
	for (const scope of scopes) {
		if (scope.dir === "") continue;
		if (relativePath.startsWith(`${scope.dir}/`) && (owner.dir === "" || scope.dir.length > owner.dir.length)) {
			owner = scope;
		}
	}
	return owner;
}

async function listGitFiles(root: string): Promise<string[]> {
	const output = await $`git ls-files -z --cached --others --exclude-standard`.cwd(root).quiet().text();
	return output.split("\0").filter(entry => entry.length > 0);
}

export async function checkBiomeMaxSize(options: CheckBiomeMaxSizeOptions): Promise<BiomeMaxSizeResult> {
	const candidates = [
		...new Set(
			(await (options.listFiles ?? listGitFiles)(options.root)).map(entry => entry.split(path.sep).join("/")),
		),
	].sort();
	const rootSettings = parseBiomeSizeSettings(await Bun.file(path.join(options.root, "biome.json")).text(), {
		configPath: "biome.json",
	});
	const scopes: BiomeConfigScope[] = [{ dir: "", configPath: "biome.json", settings: rootSettings }];
	for (const candidate of candidates) {
		const dir = configDir(candidate);
		if (dir === "" || !CONFIG_FILE_NAMES.has(path.posix.basename(candidate))) continue;
		const file = Bun.file(path.join(options.root, candidate));
		if (!(await file.exists())) continue;
		scopes.push({
			dir,
			configPath: candidate,
			settings: parseBiomeSizeSettings(await file.text(), {
				configPath: candidate,
				rootMaxSize: rootSettings.maxSize,
			}),
		});
	}

	const oversized: OversizedFile[] = [];
	let checkedFiles = 0;
	for (const candidate of candidates) {
		const scope = owningScope(candidate, scopes);
		const scopedPath = scope.dir === "" ? candidate : candidate.slice(scope.dir.length + 1);
		// Biome always loads its own config files, whatever `files.includes` says.
		const isConfig = CONFIG_FILE_NAMES.has(scopedPath);
		if (!isConfig && !matchesBiomeIncludes(scopedPath, scope.settings.includes)) continue;
		const file = Bun.file(path.join(options.root, candidate));
		// A path git still tracks but that is deleted in the working tree has nothing to process.
		if (!(await file.exists())) continue;
		checkedFiles++;
		const limit = effectiveMaxSize(scopedPath, scope.settings);
		if (file.size >= limit) {
			oversized.push({
				path: candidate,
				size: file.size,
				limit,
				config: scope.configPath,
			});
		}
	}
	return { rootMaxSize: rootSettings.maxSize, checkedFiles, oversized };
}

export function formatOversizedReport(oversized: readonly OversizedFile[]): string {
	return [
		`check-biome-max-size: ${oversized.length} file(s) reach biome files.maxSize, so Biome would skip them without failing:`,
		...oversized.map(
			entry => `  ${entry.path}: ${entry.size} bytes >= ${entry.limit} bytes (limit from ${entry.config})`,
		),
		"Fix one of these ways:",
		"  - split the file so it stays below the limit (preferred);",
		"  - raise files.maxSize in that biome.json, with a rationale in the change;",
		'  - exclude the file explicitly with a "!<path>" entry in files.includes, linking the tracking issue.',
	].join("\n");
}

async function main(): Promise<void> {
	const root = path.join(import.meta.dir, "..");
	const result = await checkBiomeMaxSize({ root });
	if (result.oversized.length > 0) {
		console.error(formatOversizedReport(result.oversized));
		process.exit(1);
	}
	console.log(
		`check-biome-max-size: all ${result.checkedFiles} Biome-processed files are below files.maxSize (root limit ${result.rootMaxSize} bytes)`,
	);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(`check-biome-max-size: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
