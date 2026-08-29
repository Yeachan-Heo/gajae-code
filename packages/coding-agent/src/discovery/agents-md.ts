/**
 * AGENTS.md Provider
 *
 * Discovers standalone AGENTS.md files by walking up from cwd.
 * This handles AGENTS.md files that live in project root (not in config directories
 * like .OpenAI code backend/ or .gemini/, which are handled by their respective providers).
 */
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import type { LoadContext, LoadResult } from "../capability/types";
import { calculateDepth, canonicalizePathWithinHome, createSourceMeta } from "./helpers";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md";
// Bound hostile ancestor walks and instruction payloads before they reach prompt assembly.
const MAX_ANCESTOR_DIRECTORIES = 32;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_AGGREGATE_BYTES = 256 * 1024;
const DIRECTORY_LIMIT_WARNING = "AGENTS.md discovery stopped after scanning 32 ancestor directories.";
const FILE_LIMIT_WARNING = "Skipped one or more AGENTS.md files that exceed the 64 KiB limit.";
const AGGREGATE_LIMIT_WARNING = "Skipped one or more AGENTS.md files that exceed the 256 KiB aggregate limit.";

export type AgentsMdReader = (
	filePath: string,
	maxBytes: number,
	options?: { noFollow?: boolean },
) => Promise<{ content: string | null; byteLength: number; tooLarge: boolean }>;

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedAgentsMdFile(
	filePath: string,
	maxBytes: number,
	options?: { noFollow?: boolean },
): Promise<{ content: string | null; byteLength: number; tooLarge: boolean }> {
	const noFollow = options?.noFollow === true;
	let before: Stats | undefined;
	try {
		if (noFollow) {
			// `loadAgentsMd` canonicalizes the candidate before calling the reader,
			// but that pathname can be swapped before open. Recheck the canonical
			// target immediately before opening and bracket the descriptor with
			// identity checks so explicit-home reads cannot follow a raced link.
			const canonicalPath = await fs.realpath(filePath);
			if (canonicalPath !== path.resolve(filePath)) return { content: null, byteLength: 0, tooLarge: false };
			before = await fs.lstat(filePath);
			if (before.isSymbolicLink() || !before.isFile()) return { content: null, byteLength: 0, tooLarge: false };
		}
		const flags =
			fs.constants.O_RDONLY |
			(typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0) |
			(noFollow && typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);
		const file = await fs.open(filePath, flags);
		try {
			const stats = await file.stat();
			if (!stats.isFile()) return { content: null, byteLength: 0, tooLarge: false };
			if (before && !sameFileIdentity(before, stats)) return { content: null, byteLength: 0, tooLarge: false };
			if (before) {
				const after = await fs.lstat(filePath);
				if (after.isSymbolicLink() || !sameFileIdentity(before, after))
					return { content: null, byteLength: 0, tooLarge: false };
			}
			const bytes = Buffer.alloc(maxBytes + 1);
			let bytesRead = 0;
			while (bytesRead < bytes.length) {
				const result = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
				if (result.bytesRead === 0) break;
				bytesRead += result.bytesRead;
			}
			if (bytesRead > maxBytes) return { content: null, byteLength: bytesRead, tooLarge: true };
			return {
				content: new TextDecoder().decode(bytes.subarray(0, bytesRead)),
				byteLength: bytesRead,
				tooLarge: false,
			};
		} finally {
			await file.close();
		}
	} catch {
		return { content: null, byteLength: 0, tooLarge: false };
	}
}

/**
 * Load standalone AGENTS.md files.
 */
export async function loadAgentsMd(
	ctx: LoadContext,
	readCandidate: AgentsMdReader = readBoundedAgentsMdFile,
): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];
	let current = ctx.cwd;
	let scannedDirectories = 0;
	let aggregateBytes = 0;
	let omittedOversizedFile = false;
	let omittedAggregateFile = false;
	const homeRelative = path.relative(ctx.home, ctx.cwd);
	const cwdIsWithinHome =
		homeRelative === "" ||
		(homeRelative !== ".." && !homeRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(homeRelative));
	const stopDirectory = ctx.repoRoot ?? (ctx.isolatedHome || cwdIsWithinHome ? ctx.home : ctx.cwd);
	const relativeStop = path.relative(stopDirectory, ctx.cwd);
	const effectiveStopDirectory =
		relativeStop === "" ||
		(relativeStop !== ".." && !relativeStop.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeStop))
			? stopDirectory
			: ctx.cwd;

	while (true) {
		scannedDirectories += 1;
		const candidate = path.join(current, "AGENTS.md");
		const parent = path.dirname(candidate);
		const baseName = parent.split(path.sep).pop() ?? "";

		if (!baseName.startsWith(".")) {
			const remainingAggregateBytes = MAX_AGGREGATE_BYTES - aggregateBytes;
			const allowedBytes = Math.min(MAX_FILE_BYTES, remainingAggregateBytes);
			const authorizedCandidate = await canonicalizePathWithinHome(ctx, candidate, undefined, "project");
			const result = authorizedCandidate
				? await readCandidate(authorizedCandidate, allowedBytes, { noFollow: ctx.isolatedHome === true })
				: { content: null, byteLength: 0, tooLarge: false };
			if (result.tooLarge) {
				if (allowedBytes < MAX_FILE_BYTES) omittedAggregateFile = true;
				else omittedOversizedFile = true;
			} else if (result.content !== null) {
				const filePath = authorizedCandidate ?? candidate;
				const fileDir = path.dirname(filePath);
				items.push({
					path: filePath,
					content: result.content,
					level: "project",
					depth: calculateDepth(ctx.cwd, fileDir, path.sep),
					_source: createSourceMeta(PROVIDER_ID, filePath, "project"),
				});
				aggregateBytes += result.byteLength;
			}
		}

		if (current === effectiveStopDirectory) break;
		if (scannedDirectories === MAX_ANCESTOR_DIRECTORIES) {
			warnings.push(DIRECTORY_LIMIT_WARNING);
			break;
		}

		const parentDirectory = path.dirname(current);
		if (parentDirectory === current) break;
		current = parentDirectory;
	}

	if (omittedOversizedFile) warnings.push(FILE_LIMIT_WARNING);
	if (omittedAggregateFile) warnings.push(AGGREGATE_LIMIT_WARNING);
	return { items, warnings };
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Standalone AGENTS.md files (Codex/Gemini style)",
	priority: 10,
	load: loadAgentsMd,
});
