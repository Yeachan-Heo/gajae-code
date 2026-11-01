/**
 * Auto-read file mentions from user prompts.
 *
 * When users reference files with @path syntax (e.g., "@src/foo.ts"),
 * we automatically inject the file contents as a FileMentionMessage
 * so the agent doesn't need to read them manually.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { ImageContent } from "@gajae-code/ai/core";
import type { glob as globFn } from "@gajae-code/natives";
import { fuzzyMatch } from "@gajae-code/tui";
import { formatAge, formatBytes, pathIsWithin, readImageMetadata, resolveEquivalentPath } from "@gajae-code/utils";
import { formatHashLines } from "../hashline/hash";
import type { FileMentionMessage } from "../session/messages";
import {
	DEFAULT_MAX_BYTES,
	formatHeadTruncationNotice,
	truncateHead,
	truncateHeadBytes,
} from "../session/streaming-output";
import { resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, resizeImage } from "./image-resize";

let fileMentionGlobLoad: Promise<typeof globFn> | undefined;

async function fileMentionGlob(): Promise<typeof globFn> {
	fileMentionGlobLoad ??= Promise.resolve((require("@gajae-code/natives") as { glob: typeof globFn }).glob);
	return await fileMentionGlobLoad;
}

/** Regex to match @filepath patterns in text */
const FILE_MENTION_REGEX = /@([^\s@]+)/g;
const LEADING_PUNCTUATION_REGEX = /^[`"'([{<]+/;
const TRAILING_PUNCTUATION_REGEX = /[)\]}>.,;:!?"'`]+$/;
const MENTION_BOUNDARY_REGEX = /[\s([{<"'`]/;
const DEFAULT_DIR_LIMIT = 500;
const MIN_FUZZY_QUERY_LENGTH = 5;
const MAX_RESOLUTION_CANDIDATES = 20_000;
const PATH_SEPARATOR_REGEX = /[/._\-\s]+/g;

type MentionDiscoveryProfile = {
	hidden: boolean;
	gitignore: boolean;
	includeNodeModules: boolean;
	maxResults: number;
	cache: boolean;
};

function getMentionCandidateDiscoveryProfile(): MentionDiscoveryProfile {
	return {
		hidden: true,
		gitignore: true,
		cache: true,
		includeNodeModules: true,
		maxResults: MAX_RESOLUTION_CANDIDATES,
	};
}

// Avoid OOM when users @mention very large files. Above these limits we skip
// auto-reading and only include the path in the message.
const MAX_AUTO_READ_TEXT_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_AUTO_READ_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB

function isMentionBoundary(text: string, index: number): boolean {
	if (index === 0) return true;
	return MENTION_BOUNDARY_REGEX.test(text[index - 1]);
}

function sanitizeMentionPath(rawPath: string): string | null {
	let cleaned = rawPath.trim();
	cleaned = cleaned.replace(LEADING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.replace(TRAILING_PUNCTUATION_REGEX, "");
	cleaned = cleaned.trim();
	return cleaned.length > 0 ? cleaned : null;
}

type MentionCandidate = {
	path: string;
	pathLower: string;
	normalizedPath: string;
	segments: string[];
};

function normalizeMentionQuery(query: string): string {
	return query.toLowerCase().replace(PATH_SEPARATOR_REGEX, "");
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await Bun.file(filePath).stat();
		return true;
	} catch {
		return false;
	}
}

async function listMentionCandidates(cwd: string): Promise<MentionCandidate[]> {
	let entries: string[];
	try {
		const discoveryProfile = getMentionCandidateDiscoveryProfile();
		const result = await (await fileMentionGlob())({
			pattern: "**/*",
			path: cwd,
			...discoveryProfile,
		});
		entries = result.matches.map(match => match.path);
	} catch {
		return [];
	}

	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const candidates: MentionCandidate[] = [];
	for (const entry of entries) {
		const pathLower = entry.toLowerCase();
		const normalizedPath = normalizeMentionQuery(entry);
		if (normalizedPath.length === 0) {
			continue;
		}
		const segments = pathLower.split(PATH_SEPARATOR_REGEX).filter(segment => segment.length > 0);
		candidates.push({ path: entry, pathLower, normalizedPath, segments });
	}
	return candidates;
}

/**
 * True when `query` can be spelled as prefixes of path segments taken in order
 * (segments may be skipped), e.g. `httpserap` → `http_server_api_tests`.
 * Plain subsequence matching would also accept letters scattered mid-word across
 * any long path, so a stray `@handle` or `@word` would resolve to an unrelated file.
 */
function matchesSegmentPrefixes(query: string, segments: string[]): boolean {
	const failed = new Set<number>();
	const visit = (segmentIndex: number, queryIndex: number): boolean => {
		if (queryIndex === query.length) return true;
		if (segmentIndex === segments.length) return false;
		const key = segmentIndex * (query.length + 1) + queryIndex;
		if (failed.has(key)) return false;
		const segment = segments[segmentIndex]!;
		for (let taken = 1; taken <= segment.length && queryIndex + taken <= query.length; taken++) {
			if (segment[taken - 1] !== query[queryIndex + taken - 1]) break;
			if (visit(segmentIndex + 1, queryIndex + taken)) return true;
		}
		if (visit(segmentIndex + 1, queryIndex)) return true;
		failed.add(key);
		return false;
	};
	return visit(0, 0);
}

async function resolveMentionPath(
	filePath: string,
	cwd: string,
	getMentionCandidates: () => Promise<MentionCandidate[]>,
): Promise<string | null> {
	const absolutePath = resolveReadPath(filePath, cwd);
	if (await pathExists(absolutePath)) {
		return filePath;
	}

	const queryLower = filePath.toLowerCase();
	const candidates = await getMentionCandidates();
	const prefixMatches = candidates.filter(candidate => candidate.pathLower.startsWith(queryLower));
	if (prefixMatches.length === 1) {
		return prefixMatches[0]?.path ?? null;
	}
	if (prefixMatches.length > 1) {
		return null;
	}

	const normalizedQuery = normalizeMentionQuery(filePath);
	if (normalizedQuery.length < MIN_FUZZY_QUERY_LENGTH) {
		return null;
	}

	const scored = candidates
		.filter(candidate => matchesSegmentPrefixes(normalizedQuery, candidate.segments))
		.map(candidate => ({ candidate, match: fuzzyMatch(normalizedQuery, candidate.normalizedPath) }))
		.filter(entry => entry.match.matches)
		.sort((a, b) => {
			if (a.match.score !== b.match.score) {
				return a.match.score - b.match.score;
			}
			return a.candidate.path.localeCompare(b.candidate.path);
		});

	if (scored.length === 0) {
		return null;
	}

	const best = scored[0];

	return best?.candidate.path ?? null;
}

/**
 * Default inline cap for auto-read file mentions, aligned with the read-tool's
 * 10 KiB bare-read receipt so an incidental `@path` mention injects a bounded
 * snippet. Overridable per call.
 */
export const DEFAULT_FILE_MENTION_INLINE_BYTES = 10 * 1024;

function buildTextOutput(textContent: string, maxInlineBytes?: number): { output: string; lineCount: number } {
	const cap = maxInlineBytes && maxInlineBytes > 0 ? maxInlineBytes : DEFAULT_FILE_MENTION_INLINE_BYTES;
	const allLines = textContent.split("\n");
	const totalFileLines = allLines.length;
	const truncation = truncateHead(textContent, { maxBytes: cap });

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[0] ?? "";
		const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
		const snippet = truncateHeadBytes(firstLine, cap);
		let outputText = snippet.text;

		if (outputText.length > 0) {
			outputText += `\n\n[Line 1 is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
				cap,
			)} limit. Showing first ${formatBytes(snippet.bytes)} of the line.]`;
		} else {
			outputText = `[Line 1 is ${formatBytes(firstLineBytes)}, exceeds ${formatBytes(
				cap,
			)} limit. Unable to display a valid UTF-8 snippet.]`;
		}

		return { output: outputText, lineCount: totalFileLines };
	}

	let outputText = truncation.content;

	if (truncation.truncated) {
		outputText += formatHeadTruncationNotice(truncation, { startLine: 1, totalFileLines });
	}

	return { output: outputText, lineCount: totalFileLines };
}

async function buildDirectoryListing(absolutePath: string): Promise<{ output: string; lineCount: number }> {
	let entries: string[];
	try {
		entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: absolutePath, dot: true, onlyFiles: false }));
	} catch {
		return { output: "(empty directory)", lineCount: 1 };
	}

	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

	const results: string[] = [];
	let entryLimitReached = false;

	for (const entry of entries) {
		if (results.length >= DEFAULT_DIR_LIMIT) {
			entryLimitReached = true;
			break;
		}

		const fullPath = path.join(absolutePath, entry);
		let suffix = "";
		let age = "";

		try {
			const stat = await Bun.file(fullPath).stat();
			if (stat.isDirectory()) {
				suffix = "/";
			}
			const ageSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
			age = formatAge(ageSeconds);
		} catch {
			continue;
		}

		const line = age ? `${entry}${suffix} (${age})` : `${entry}${suffix}`;
		results.push(line);
	}

	if (results.length === 0) {
		return { output: "(empty directory)", lineCount: 1 };
	}

	const rawOutput = results.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;

	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${DEFAULT_DIR_LIMIT} entries limit reached. Use limit=${DEFAULT_DIR_LIMIT * 2} for more`);
	}
	if (truncation.truncated) {
		notices.push(`${formatBytes(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}

	return { output, lineCount: output.split("\n").length };
}

/** Extract all @filepath mentions from text */
export function extractFileMentions(text: string): string[] {
	const matches = [...text.matchAll(FILE_MENTION_REGEX)];
	const mentions: string[] = [];

	for (const match of matches) {
		const index = match.index ?? 0;
		if (!isMentionBoundary(text, index)) continue;

		const cleaned = sanitizeMentionPath(match[1]);
		if (!cleaned) continue;

		mentions.push(cleaned);
	}

	return [...new Set(mentions)];
}

/**
 * Compare canonical Windows paths without folding directory names: individual
 * directories can opt into case-sensitive names.
 */
export function isCanonicalWindowsPathWithin(root: string, candidate: string): boolean {
	if (!path.win32.isAbsolute(root) || !path.win32.isAbsolute(candidate)) return false;

	const canonicalRoot = path.win32.resolve(root);
	const canonicalCandidate = path.win32.resolve(candidate);
	const rootParts = path.win32.parse(canonicalRoot);
	const candidateParts = path.win32.parse(canonicalCandidate);
	if (rootParts.root.toLowerCase() !== candidateParts.root.toLowerCase()) return false;

	const rootSegments = canonicalRoot.slice(rootParts.root.length).split(path.win32.sep).filter(Boolean);
	const candidateSegments = canonicalCandidate.slice(candidateParts.root.length).split(path.win32.sep).filter(Boolean);
	if (candidateSegments.length < rootSegments.length) return false;

	return rootSegments.every((segment, index) => segment === candidateSegments[index]);
}

/**
 * Generate a FileMentionMessage containing the contents of mentioned files.
 * Returns empty array if no files could be read.
 */
export async function generateFileMentionMessages(
	filePaths: string[],
	cwd: string,
	options?: {
		autoResizeImages?: boolean;
		useHashLines?: boolean;
		/** Inline byte cap for auto-read text. Default: DEFAULT_FILE_MENTION_INLINE_BYTES. */
		maxInlineBytes?: number;
		/**
		 * Resolved paths already shown (read or mentioned) recently in the
		 * conversation. A mention of one of these emits a compact duplicate note
		 * instead of re-injecting the full body.
		 */
		recentlyShownPaths?: ReadonlySet<string>;
	},
): Promise<AgentMessage[]> {
	if (filePaths.length === 0) return [];

	const autoResizeImages = options?.autoResizeImages ?? true;
	const canonicalWindowsCwd = process.platform === "win32" ? await fs.realpath(cwd).catch(() => undefined) : undefined;
	if (process.platform === "win32" && canonicalWindowsCwd === undefined) return [];

	const files: FileMentionMessage["files"] = [];
	let mentionCandidatesPromise: Promise<MentionCandidate[]> | null = null;
	const getMentionCandidates = (): Promise<MentionCandidate[]> => {
		mentionCandidatesPromise ??= listMentionCandidates(cwd);
		return mentionCandidatesPromise;
	};

	const shownInBatch = new Set<string>();
	for (const filePath of filePaths) {
		const resolvedPath = await resolveMentionPath(filePath, cwd, getMentionCandidates);
		if (!resolvedPath) {
			continue;
		}
		const absolutePath = resolveReadPath(resolvedPath, cwd);
		// Skip `..`, `~`, and outside absolute paths. On Windows, realpath both
		// paths and compare exact components because directories can be case-sensitive.
		// Fail closed if either real path is unavailable. Read the canonical path so
		// replacing the original mention symlink does not retarget this read.
		const canonicalPath =
			process.platform === "win32"
				? await fs.realpath(absolutePath).catch(() => undefined)
				: resolveEquivalentPath(absolutePath);
		if (!canonicalPath) {
			continue;
		}
		const staysWithinSession =
			process.platform === "win32"
				? canonicalWindowsCwd !== undefined && isCanonicalWindowsPathWithin(canonicalWindowsCwd, canonicalPath)
				: pathIsWithin(cwd, canonicalPath);
		if (!staysWithinSession) {
			continue;
		}
		// Duplicate suppression, keyed by absolute path: same path shown earlier this
		// batch or recently in the conversation → compact note, no re-read (the path
		// stays referenced so the model can re-fetch via the read tool).
		if (shownInBatch.has(absolutePath) || options?.recentlyShownPaths?.has(absolutePath)) {
			files.push({
				path: resolvedPath,
				content: `(already shown in this conversation; not re-read — use the read tool to fetch \`${resolvedPath}\` again)`,
				duplicate: true,
			});
			continue;
		}
		shownInBatch.add(absolutePath);
		try {
			const stat = await Bun.file(canonicalPath).stat();
			if (stat.isDirectory()) {
				const { output, lineCount } = await buildDirectoryListing(canonicalPath);
				files.push({ path: resolvedPath, content: output, lineCount });
				continue;
			}

			const imageMetadata = await readImageMetadata(canonicalPath);
			const mimeType = imageMetadata?.mimeType;
			if (mimeType) {
				if (stat.size > MAX_AUTO_READ_IMAGE_BYTES) {
					files.push({
						path: resolvedPath,
						content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
						byteSize: stat.size,
						skippedReason: "tooLarge",
					});
					continue;
				}
				const buffer = await fs.readFile(canonicalPath);
				if (buffer.length === 0) {
					continue;
				}

				const base64Content = buffer.toBase64();
				let image: ImageContent = { type: "image", mimeType, data: base64Content };
				let dimensionNote: string | undefined;

				if (autoResizeImages) {
					try {
						const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
						dimensionNote = formatDimensionNote(resized);
						image = {
							type: "image",
							mimeType: resized.mimeType,
							data: resized.data,
						};
					} catch {
						image = { type: "image", mimeType, data: base64Content };
					}
				}

				files.push({ path: resolvedPath, content: dimensionNote ?? "", image });
				continue;
			}

			if (stat.size > MAX_AUTO_READ_TEXT_BYTES) {
				files.push({
					path: resolvedPath,
					content: `(skipped auto-read: too large, ${formatBytes(stat.size)})`,
					byteSize: stat.size,
					skippedReason: "tooLarge",
				});
				continue;
			}

			const content = await Bun.file(canonicalPath).text();
			let { output, lineCount } = buildTextOutput(content, options?.maxInlineBytes);
			if (options?.useHashLines) {
				output = formatHashLines(output);
			}
			files.push({ path: resolvedPath, content: output, lineCount });
		} catch {
			// File doesn't exist or isn't readable - skip silently
		}
	}

	if (files.length === 0) return [];

	const message: FileMentionMessage = {
		role: "fileMention",
		files,
		timestamp: Date.now(),
	};

	return [message];
}
