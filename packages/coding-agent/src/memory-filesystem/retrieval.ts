import {
	FILESYSTEM_MEMORY_MAX_DIRECTORY_DEPTH,
	FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES,
	FILESYSTEM_MEMORY_MAX_READ_BYTES,
	FILESYSTEM_MEMORY_MAX_VISITED_DIRECTORIES,
	type FilesystemMemoryMapV1,
	type FilesystemMemoryOutcome,
	type FilesystemMemoryScope,
	type FilesystemMemoryUri,
} from "./contracts";
import {
	containsFilesystemMemorySecretLikeContent,
	type FilesystemMemoryDocument,
	filesystemMemoryHeadingRange,
	parseFilesystemMemoryDocument,
} from "./document";
import { resolveFilesystemMemoryMapRoute } from "./map";
import { listSafeFilesystemMemoryDirectory, readSafeFilesystemMemoryFile } from "./safe-path";
import { parseFilesystemMemoryUri } from "./uri";

export const FILESYSTEM_MEMORY_MAX_SELECTED_RESULTS = 32;

export interface FilesystemMemoryRoots {
	readonly global?: string;
	readonly project?: string;
	readonly "project-local"?: string;
	readonly session?: string;
}
export interface FilesystemMemoryCitation {
	readonly uri: string;
	readonly scope: FilesystemMemoryScope;
	readonly heading: string | null;
	readonly lines: readonly [number, number];
	readonly digest: string;
	readonly authority: "user" | "repository" | "private";
	readonly freshness: "current";
	readonly volatility: "stable" | "volatile";
	readonly verificationRequired: boolean;
}
export interface FilesystemMemoryResult {
	readonly citation: FilesystemMemoryCitation;
	readonly content: string;
	readonly score: readonly number[];
}
export interface FilesystemMemoryExcluded {
	readonly uri: string | null;
	readonly code: string;
}
export interface FilesystemMemoryRetrieval {
	readonly results: readonly FilesystemMemoryResult[];
	readonly excluded: readonly FilesystemMemoryExcluded[];
	readonly truncated: boolean;
}
export interface FilesystemMemorySearchOptions {
	readonly query: string;
	readonly map?: FilesystemMemoryMapV1;
	readonly routeId?: string;
	readonly limit?: number;
}
interface Candidate {
	readonly uri: FilesystemMemoryUri;
	readonly root: string;
}

function words(value: string): readonly string[] {
	return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [])].sort((a, b) =>
		a.localeCompare(b),
	);
}
function authority(scope: FilesystemMemoryScope): "user" | "repository" | "private" {
	return scope === "global" ? "user" : scope === "project" ? "repository" : "private";
}
function compareNumbers(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < left.length; index += 1)
		if (left[index] !== right[index]) return right[index] - left[index];
	return 0;
}

async function discover(
	roots: FilesystemMemoryRoots,
): Promise<{ candidates: Candidate[]; excluded: FilesystemMemoryExcluded[]; truncated: boolean }> {
	const candidates: Candidate[] = [];
	const excluded: FilesystemMemoryExcluded[] = [];
	let directories = 0;
	let entries = 0;
	let truncated = false;
	for (const scope of ["global", "project", "project-local", "session"] as const) {
		const root = roots[scope];
		if (!root) continue;
		const queue: Array<{ components: string[]; depth: number }> = [{ components: [], depth: 0 }];
		while (queue.length) {
			const current = queue.shift();
			if (!current) break;
			if (++directories > FILESYSTEM_MEMORY_MAX_VISITED_DIRECTORIES) {
				truncated = true;
				break;
			}
			const listed = await listSafeFilesystemMemoryDirectory(
				root,
				current.components,
				FILESYSTEM_MEMORY_MAX_INSPECTED_ENTRIES - entries,
			);
			if (listed.code !== "ok") {
				excluded.push({ uri: null, code: "unsafe_directory" });
				continue;
			}
			const entriesHere = listed.value.entries;
			entries += entriesHere.length;
			if (listed.value.truncated) truncated = true;
			for (const entry of entriesHere) {
				if (entry.type === "symlink") {
					excluded.push({ uri: null, code: "symlink_denied" });
					continue;
				}
				const components = [...current.components, entry.name];
				if (entry.type === "directory") {
					if (current.depth < FILESYSTEM_MEMORY_MAX_DIRECTORY_DEPTH)
						queue.push({ components, depth: current.depth + 1 });
					else truncated = true;
					continue;
				}
				if (entry.type !== "file" || !entry.name.endsWith(".md")) continue;
				const formatted = parseFilesystemMemoryUri(`${scope}:///${components.map(encodeURIComponent).join("/")}`);
				if (formatted.code === "ok") candidates.push({ uri: formatted.value, root });
			}
			if (truncated) break;
		}
	}
	return {
		candidates: candidates.sort((left, right) => left.uri.canonical.localeCompare(right.uri.canonical)),
		excluded,
		truncated,
	};
}

async function load(candidate: Candidate): Promise<FilesystemMemoryOutcome<FilesystemMemoryDocument>> {
	const read = await readSafeFilesystemMemoryFile(
		candidate.root,
		candidate.uri.components,
		FILESYSTEM_MEMORY_MAX_READ_BYTES,
	);
	if (read.code !== "ok") return read;
	return parseFilesystemMemoryDocument(read.value.bytes);
}

function makeResult(
	candidate: Candidate,
	document: FilesystemMemoryDocument,
	query: readonly string[],
	explicit: boolean,
): FilesystemMemoryResult | null {
	if (document.metadata.status && document.metadata.status !== "active") return null;
	if (candidate.uri.scope === "project" && containsFilesystemMemorySecretLikeContent(document.body)) return null;
	const heading = document.headings.find(item => words(item.text).some(token => query.includes(token))) ?? null;
	const metadata = [document.metadata.title ?? "", ...(document.metadata.tags ?? [])].join(" ");
	const haystack = `${metadata}\n${document.body}`.toLocaleLowerCase();
	const lexical = query.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
	const exactUri = query.includes(candidate.uri.canonical.toLocaleLowerCase()) ? 1 : 0;
	const metadataExact = query.some(token => words(metadata).includes(token)) ? 1 : 0;
	const score = [exactUri, explicit ? 1 : 0, metadataExact, heading ? 1 : 0, lexical];
	if (!explicit && !exactUri && !metadataExact && !heading && lexical === 0) return null;
	const range = filesystemMemoryHeadingRange(document, heading);
	return {
		citation: {
			uri: candidate.uri.canonical,
			scope: candidate.uri.scope,
			heading: heading?.text ?? null,
			lines: range,
			digest: document.digest,
			authority: authority(candidate.uri.scope),
			freshness: "current",
			volatility: document.metadata.volatility ?? "stable",
			verificationRequired: document.metadata.volatility === "volatile",
		},
		content: document.body,
		score,
	};
}

export async function getFilesystemMemoryDocument(
	roots: FilesystemMemoryRoots,
	uriText: string,
): Promise<FilesystemMemoryOutcome<FilesystemMemoryResult>> {
	const parsed = parseFilesystemMemoryUri(uriText);
	if (parsed.code !== "ok") return parsed;
	if (!parsed.value.components.at(-1)?.endsWith(".md"))
		return { code: "invalid_path", message: "Memory get requires a Markdown document URI." };
	const root = roots[parsed.value.scope];
	if (!root) return { code: "policy_denied", message: "Memory scope is unavailable." };
	const document = await load({ uri: parsed.value, root });
	if (document.code !== "ok") return document;
	const result = makeResult({ uri: parsed.value, root }, document.value, [], true);
	return result
		? { code: "ok", value: result }
		: { code: "policy_denied", message: "Document is excluded by content policy." };
}

export async function searchFilesystemMemory(
	roots: FilesystemMemoryRoots,
	options: FilesystemMemorySearchOptions,
): Promise<FilesystemMemoryOutcome<FilesystemMemoryRetrieval>> {
	const query = words(options.query);
	if (!query.length) return { code: "invalid_path", message: "Search query is required." };
	const limit = options.limit ?? FILESYSTEM_MEMORY_MAX_SELECTED_RESULTS;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > FILESYSTEM_MEMORY_MAX_SELECTED_RESULTS)
		return { code: "invalid_path", message: "Result limit is invalid." };
	const routeTargets = new Set<string>();
	if (options.routeId) {
		if (!options.map) return { code: "not_found", message: "MAP is unavailable." };
		const route = resolveFilesystemMemoryMapRoute(options.map, options.routeId);
		if (route.code !== "ok") return route;
		for (const target of route.value.targets) routeTargets.add(target);
	}
	const found = await discover(roots);
	const results: FilesystemMemoryResult[] = [];
	for (const candidate of found.candidates) {
		const document = await load(candidate);
		if (document.code !== "ok") {
			found.excluded.push({ uri: candidate.uri.canonical, code: document.code });
			continue;
		}
		const result = makeResult(candidate, document.value, query, routeTargets.has(candidate.uri.canonical));
		if (result) results.push(result);
		else found.excluded.push({ uri: candidate.uri.canonical, code: "excluded" });
	}
	results.sort(
		(left, right) => compareNumbers(left.score, right.score) || left.citation.uri.localeCompare(right.citation.uri),
	);
	return {
		code: "ok",
		value: {
			results: results.slice(0, limit),
			excluded: found.excluded.sort((left, right) =>
				`${left.uri}:${left.code}`.localeCompare(`${right.uri}:${right.code}`),
			),
			truncated: found.truncated || results.length > limit,
		},
	};
}

export const recallFilesystemMemory = searchFilesystemMemory;
