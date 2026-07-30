#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const ASSET_NAME = "gjc-light-theme-compliance.tar.gz";
const RELEASE_PREFIX = "light-theme-evidence-";
const EXPECTED_ENTRY_COUNT = 180;
const EXPECTED_ENTRY_LEAF_COUNT = 900;
const EXPECTED_ARCHIVE_FILE_COUNT = 905;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const ENTRY_FILENAMES = [
	"metadata.json",
	"terminal-ansi.txt",
	"terminal.html",
	"terminal.png",
	"terminal.txt",
] as const;
const ROOT_FILENAMES = [
	"capture-environment.json",
	"independent-review.json",
	"manifest.json",
	"review-input.json",
	"run-receipt.json",
] as const;

interface DownloadOptions {
	repository: string;
	revision: string;
	outputRoot: string;
	runnerTemp: string;
	fetcher?: (url: string) => Promise<Response>;
	githubEnvPath?: string;
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function hasLexicalParent(candidate: string): boolean {
	return candidate.split(/[\\/]/).includes("..");
}

function strictDescendant(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
	let cursor = path.resolve(root);
	for (const segment of path.relative(cursor, path.resolve(target)).split(path.sep)) {
		cursor = path.join(cursor, segment);
		try {
			const stats = await fs.lstat(cursor);
			if (stats.isSymbolicLink()) throw new Error(`Evidence path contains a symlink component: ${cursor}`);
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
	}
}

export async function resolveEvidenceOutputRoot(candidate: string, runnerTemp: string): Promise<string> {
	if (
		!candidate ||
		!runnerTemp ||
		hasLexicalParent(candidate) ||
		/[\0\r\n]/.test(candidate) ||
		/[\0\r\n]/.test(runnerTemp)
	) {
		throw new Error("Evidence output must be a strict descendant of RUNNER_TEMP without '..'");
	}
	const resolvedRunnerTemp = path.resolve(runnerTemp);
	const outputRoot = path.resolve(candidate);
	if (!strictDescendant(resolvedRunnerTemp, outputRoot)) {
		throw new Error("Evidence output must be a strict descendant of RUNNER_TEMP");
	}
	const runnerStats = await fs.lstat(resolvedRunnerTemp);
	if (!runnerStats.isDirectory() || runnerStats.isSymbolicLink()) {
		throw new Error("RUNNER_TEMP must be a real directory");
	}
	await assertNoSymlinkComponents(resolvedRunnerTemp, outputRoot);
	try {
		await fs.lstat(outputRoot);
		throw new Error("Evidence output already exists");
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	return outputRoot;
}

export function lightThemeEvidenceReleaseUrl(repository: string, revision: string): string {
	if (!REPOSITORY_PATTERN.test(repository)) throw new Error(`Invalid evidence repository: ${repository}`);
	if (!REVISION_PATTERN.test(revision)) throw new Error(`Invalid evidence revision: ${revision}`);
	return `https://github.com/${repository}/releases/download/${RELEASE_PREFIX}${revision}/${ASSET_NAME}`;
}

export function validateEvidenceArchivePaths(paths: readonly string[]): void {
	if (paths.length !== EXPECTED_ARCHIVE_FILE_COUNT || new Set(paths).size !== paths.length) {
		throw new Error(`Evidence archive must contain exactly ${EXPECTED_ARCHIVE_FILE_COUNT} unique files`);
	}
	const rootFiles: string[] = [];
	const entryFiles = new Map<string, string[]>();
	for (const entryPath of paths) {
		if (
			!entryPath ||
			entryPath.includes("\\") ||
			path.posix.isAbsolute(entryPath) ||
			path.posix.normalize(entryPath) !== entryPath ||
			entryPath.startsWith("../")
		) {
			throw new Error(`Unsafe evidence archive path: ${entryPath}`);
		}
		const components = entryPath.split("/");
		if (components.length === 1) {
			rootFiles.push(entryPath);
			continue;
		}
		if (components.length !== 5) throw new Error(`Invalid evidence entry path: ${entryPath}`);
		const [theme, scene, viewport, renderMode, filename] = components;
		if (
			(theme !== "blue-crab-light" && theme !== "red-claw-light") ||
			!scene ||
			!viewport ||
			!renderMode ||
			!ENTRY_FILENAMES.includes(filename as (typeof ENTRY_FILENAMES)[number])
		) {
			throw new Error(`Invalid evidence entry path: ${entryPath}`);
		}
		const entryKey = components.slice(0, 4).join("/");
		const filenames = entryFiles.get(entryKey) ?? [];
		filenames.push(filename);
		entryFiles.set(entryKey, filenames);
	}
	const sorted = (values: readonly string[]): string[] => [...values].sort((left, right) => left.localeCompare(right));
	if (sorted(rootFiles).join("\n") !== sorted(ROOT_FILENAMES).join("\n")) {
		throw new Error("Evidence archive root controls do not match the canonical set");
	}
	if (entryFiles.size !== EXPECTED_ENTRY_COUNT) {
		throw new Error(`Evidence archive must contain exactly ${EXPECTED_ENTRY_COUNT} entry directories`);
	}
	for (const [entryKey, filenames] of entryFiles) {
		if (sorted(filenames).join("\n") !== sorted(ENTRY_FILENAMES).join("\n")) {
			throw new Error(`Evidence archive entry leaves do not match the canonical set: ${entryKey}`);
		}
	}
	if (
		[...entryFiles.values()].reduce((total, filenames) => total + filenames.length, 0) !== EXPECTED_ENTRY_LEAF_COUNT
	) {
		throw new Error(`Evidence archive must contain exactly ${EXPECTED_ENTRY_LEAF_COUNT} entry leaves`);
	}
}

export function validateEvidenceArchiveSizes(sizes: readonly number[]): void {
	let total = 0;
	for (const size of sizes) {
		if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE_BYTES) {
			throw new Error("Evidence archive contains an invalid or oversized file");
		}
		total += size;
		if (!Number.isSafeInteger(total) || total > MAX_ARCHIVE_BYTES) {
			throw new Error("Evidence archive extracted size exceeds the limit");
		}
	}
}

export async function extractEvidenceArchive(
	archiveBytes: Uint8Array,
	outputRoot: string,
	runnerTemp: string,
): Promise<string> {
	if (archiveBytes.byteLength === 0 || archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
		throw new Error("Evidence archive size is empty or exceeds the limit");
	}
	const destination = await resolveEvidenceOutputRoot(outputRoot, runnerTemp);
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	validateEvidenceArchivePaths([...files.keys()]);
	validateEvidenceArchiveSizes([...files.values()].map(file => file.size));
	await fs.mkdir(destination, { recursive: true });
	for (const [relativePath, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
		const target = path.join(destination, ...relativePath.split("/"));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, file);
	}
	return destination;
}

async function collectArchiveFiles(
	sourceRoot: string,
	currentDirectory: string,
	files: Record<string, Uint8Array>,
): Promise<void> {
	for (const entry of (await fs.readdir(currentDirectory, { withFileTypes: true })).sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const absolutePath = path.join(currentDirectory, entry.name);
		const relativePath = path.relative(sourceRoot, absolutePath).split(path.sep).join("/");
		if (entry.isSymbolicLink()) throw new Error(`Evidence source contains a symlink: ${relativePath}`);
		if (entry.isDirectory()) {
			await collectArchiveFiles(sourceRoot, absolutePath, files);
		} else if (entry.isFile()) {
			files[relativePath] = new Uint8Array(await Bun.file(absolutePath).arrayBuffer());
		} else {
			throw new Error(`Evidence source contains a non-file entry: ${relativePath}`);
		}
	}
}

export async function createEvidenceArchive(sourceRoot: string, outputPath: string): Promise<void> {
	const source = path.resolve(sourceRoot);
	const output = path.resolve(outputPath);
	const sourceStats = await fs.lstat(source);
	if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink())
		throw new Error("Evidence source must be a real directory");
	if (strictDescendant(source, output) || output === source)
		throw new Error("Evidence archive output cannot be inside its source");
	try {
		await fs.lstat(output);
		throw new Error("Evidence archive output already exists");
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	const files: Record<string, Uint8Array> = {};
	await collectArchiveFiles(source, source, files);
	validateEvidenceArchivePaths(Object.keys(files));
	await Bun.Archive.write(output, files, { compress: "gzip", level: 9 });
}

export async function downloadLightThemeEvidence(options: DownloadOptions): Promise<string> {
	const url = lightThemeEvidenceReleaseUrl(options.repository, options.revision);
	const response = await (options.fetcher ?? (requestUrl => fetch(requestUrl, { redirect: "follow" })))(url);
	if (!response.ok) throw new Error(`Cannot download exact-head light-theme evidence: HTTP ${response.status}`);
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
		throw new Error("Evidence archive exceeds the download limit");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const destination = await extractEvidenceArchive(bytes, options.outputRoot, options.runnerTemp);
	if (options.githubEnvPath) {
		await fs.appendFile(
			options.githubEnvPath,
			`GJC_LIGHT_THEME_EVIDENCE=${destination}\nGJC_LIGHT_THEME_EVIDENCE_REQUIRED=1\n`,
		);
	}
	return destination;
}

function flagValue(args: readonly string[], name: string): string {
	const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
	if (
		indexes.length !== 1 ||
		indexes[0] === undefined ||
		!args[indexes[0] + 1] ||
		args[indexes[0] + 1]!.startsWith("--")
	) {
		throw new Error(`Expected exactly one ${name} value`);
	}
	return args[indexes[0] + 1]!;
}

async function main(): Promise<void> {
	const [mode, ...args] = process.argv.slice(2);
	if (mode === "download" && args.length === 6) {
		const destination = await downloadLightThemeEvidence({
			repository: flagValue(args, "--repository"),
			revision: flagValue(args, "--revision"),
			outputRoot: flagValue(args, "--output"),
			runnerTemp: Bun.env.RUNNER_TEMP ?? "",
			githubEnvPath: Bun.env.GITHUB_ENV,
		});
		process.stdout.write(`Prepared exact-head light-theme evidence at ${destination}\n`);
		return;
	}
	if (mode === "archive" && args.length === 4) {
		const output = flagValue(args, "--output");
		await createEvidenceArchive(flagValue(args, "--source"), output);
		process.stdout.write(`Created light-theme evidence archive at ${path.resolve(output)}\n`);
		return;
	}
	throw new Error(
		"Usage: ci-light-theme-evidence.ts download --repository <owner/repo> --revision <40-hex> --output <RUNNER_TEMP/path> | archive --source <corpus> --output <tar.gz>",
	);
}

if (import.meta.main) await main();
