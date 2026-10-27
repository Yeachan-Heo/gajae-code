/**
 * Patch application logic for the edit tool.
 *
 * Applies parsed diff hunks to file content using fuzzy matching
 * for robust handling of whitespace and formatting differences.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gajae-code/agent-core";
import { isEnoent } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { Settings } from "../../config/settings";
import {
	type FileDiagnosticsResult,
	flushLspWritethroughBatch,
	type WritethroughCallback,
	type WritethroughDeferredHandle,
} from "../../lsp";
import type { ToolSession } from "../../tools";
import { assertEditableFile } from "../../tools/auto-generated-guard";
import {
	invalidateFsScanAfterDelete,
	invalidateFsScanAfterRename,
	invalidateFsScanAfterWrite,
} from "../../tools/fs-cache-invalidation";
import { outputMeta } from "../../tools/output-meta";
import { resolveToCwd } from "../../tools/path-utils";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/plan-mode-guard";
import { ToolError } from "../../tools/tool-errors";
import { ApplyPatchError, generateUnifiedDiffString, normalizeCreateContent } from "../diff";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../normalize";
import { withEditPathMutation } from "../path-mutation-lock";
import { readEditFileText, serializeEditFileText } from "../read-file";
import type { EditToolDetails, LspBatchRequest } from "../renderer";
import { DEFAULT_FUZZY_THRESHOLD } from "./replace";

export type Operation = "create" | "delete" | "update";

export interface PatchInput {
	path: string;
	op: Operation;
	rename?: string;
	diff?: string;
}

export interface FileSystem {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	readBinary?: (path: string) => Promise<Uint8Array>;
	write(path: string, content: string): Promise<void>;
	delete(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

interface FileChange {
	type: Operation;
	path: string;
	newPath?: string;
	oldContent?: string;
	newContent?: string;
}

export interface ApplyPatchResult {
	change: FileChange;
	warnings?: string[];
}

export interface ApplyPatchOptions {
	cwd: string;
	dryRun?: boolean;
	fuzzyThreshold?: number;
	allowFuzzy?: boolean;
	fs?: FileSystem;
	/**
	 * When false, skip durable cross-process file locks (in-process path mutex
	 * still serializes). Defaults to true only for the real `defaultFileSystem`
	 * (or when `fs` is omitted). Disk-backed adapters that are not
	 * `defaultFileSystem` (notably production `LspFileSystem` via
	 * `executePatchSingle`) MUST pass `crossProcessLock: true` explicitly —
	 * object identity is not a durable-lock capability probe.
	 */
	crossProcessLock?: boolean;
	/** Explicit artifacts `local` root for this call. The caller session owns it. */
	localRoot?: string;
	signal?: AbortSignal;
	/**
	 * Recheck a rename destination while this call holds the path mutation lock.
	 * The request preflight runs before that lock.
	 */
	destinationGuard?: {
		settings: Pick<Settings, "get">;
		displayPath: string;
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Default File System
// ═══════════════════════════════════════════════════════════════════════════

/** Default filesystem implementation using Bun APIs */
export const defaultFileSystem: FileSystem = {
	async exists(path: string): Promise<boolean> {
		return Bun.file(path).exists();
	},
	async read(path: string): Promise<string> {
		return readEditFileText(path, path);
	},
	async readBinary(path: string): Promise<Uint8Array> {
		return fs.promises.readFile(path);
	},
	async write(path: string, content: string): Promise<void> {
		await Bun.write(path, await serializeEditFileText(path, path, content));
	},
	async delete(path: string): Promise<void> {
		await fs.promises.unlink(path);
	},
	async mkdir(path: string): Promise<void> {
		await fs.promises.mkdir(path, { recursive: true });
	},
};

// Load the native patch engine only when patch application first runs.
type NativePatchBindings = typeof import("@gajae-code/natives");
let nativePatchBindingsPromise: Promise<NativePatchBindings> | undefined;

function loadNativePatchBindings(): Promise<NativePatchBindings> {
	nativePatchBindingsPromise ??= import("@gajae-code/natives");
	return nativePatchBindingsPromise;
}

function explicitLocalRootForSession(session: ToolSession): string | undefined {
	const artifactsDir = session.getArtifactsDir?.();
	if (!artifactsDir || session.isManagedSessionDestination?.()) return undefined;
	return path.resolve(artifactsDir, "local");
}

function pathIsWithin(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Trust root for a delete. `localRoot` is the caller session's explicit
 * artifacts root. `gjc-local/<id>` is recognized from the path. Else `cwd`.
 */
function boundaryForPatchDelete(cwd: string, absolutePath: string, localRoot?: string): string {
	const resolved = path.resolve(absolutePath);
	if (localRoot) {
		const explicit = path.resolve(localRoot);
		if (pathIsWithin(resolved, explicit)) return explicit;
	}
	const managedParent = path.join(os.tmpdir(), "gjc-local");
	if (pathIsWithin(resolved, managedParent)) {
		const rest = resolved.slice(managedParent.length + path.sep.length);
		const sessionSegment = rest.split(path.sep, 1)[0] ?? "";
		if (sessionSegment.length > 0) return path.join(managedParent, sessionSegment);
	}
	return path.resolve(cwd);
}

/**
 * `unlink` follows a directory symlink. Resolve the parent only, then delete
 * that real parent plus the final name so a file symlink is removed as a link.
 */
async function resolvePatchDeletePath(
	root: string,
	absolutePath: string,
	displayPath: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	let realRoot: string;
	try {
		realRoot = await fs.promises.realpath(root);
	} catch (error) {
		if (isEnoent(error)) throw new ApplyPatchError(`File not found: ${displayPath}`);
		throw error;
	}
	signal?.throwIfAborted();
	let realParent: string;
	try {
		realParent = await fs.promises.realpath(path.dirname(absolutePath));
	} catch (error) {
		if (isEnoent(error)) throw new ApplyPatchError(`File not found: ${displayPath}`);
		throw error;
	}
	signal?.throwIfAborted();
	if (!pathIsWithin(realParent, realRoot)) {
		throw new ApplyPatchError(`Delete target resolves outside its root: ${displayPath}`);
	}
	return path.join(realParent, path.basename(absolutePath));
}

/**
 * `mkdir` follows a directory symlink. Walk to the nearest existing ancestor
 * and return its real path plus the missing suffix. A parent that is already
 * lexically outside the workspace or session local root is unchanged.
 */
async function resolvePatchMkdirPath(
	cwd: string,
	absolutePath: string,
	localRoot: string | undefined,
	parentDir: string,
	displayPath: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const boundary = path.resolve(boundaryForPatchDelete(cwd, absolutePath, localRoot));
	const lexicalParent = path.resolve(parentDir);
	if (!pathIsWithin(lexicalParent, boundary)) return parentDir;
	// A root that does not exist yet is not an escape. Keep the missing suffix
	// under its real ancestor, which is what mkdir did before this check.
	const realRoot = await realpathThroughExistingAncestor(boundary, signal);
	signal?.throwIfAborted();
	const realParent = await realpathThroughExistingAncestor(lexicalParent, signal);
	signal?.throwIfAborted();
	if (!pathIsWithin(realParent, realRoot)) {
		throw new ApplyPatchError(`Parent directory resolves outside its root: ${displayPath}`);
	}
	return realParent;
}

async function realpathThroughExistingAncestor(target: string, signal?: AbortSignal): Promise<string> {
	const resolved = path.resolve(target);
	const missing: string[] = [];
	let cursor = resolved;
	for (;;) {
		signal?.throwIfAborted();
		try {
			const real = await fs.promises.realpath(cursor);
			return missing.length === 0 ? real : path.join(real, ...missing.reverse());
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) return resolved;
			missing.push(path.basename(cursor));
			cursor = parent;
		}
	}
}

async function readExistingPatchFile(fileSystem: FileSystem, absolutePath: string, path: string): Promise<string> {
	try {
		return await fileSystem.read(absolutePath);
	} catch (error) {
		if (isEnoent(error) || (error instanceof Error && error.message.startsWith("File not found:"))) {
			throw new ApplyPatchError(`File not found: ${path}`);
		}
		throw error;
	}
}

async function applyPatchText(
	content: string,
	path: string,
	diff: string,
	threshold: number,
	allowFuzzy: boolean,
): Promise<{ content: string; warnings: string[] }> {
	try {
		return await (await loadNativePatchBindings()).editPatchApplyText(content, path, diff, threshold, allowFuzzy);
	} catch (error) {
		throw new ApplyPatchError(error instanceof Error ? error.message : String(error));
	}
}
// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply a patch operation to the filesystem.
 *
 * Concurrent mutations of the same absolute path are serialized (in-process always;
 * cross-process file lock when using the real filesystem) so disjoint concurrent
 * edits cannot silently overwrite each other (#2900).
 */
export async function applyPatch(input: PatchInput, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	const resolvePath = (p: string): string => resolveToCwd(p, options.cwd);
	const absolutePath = resolvePath(input.path);
	const mutationPaths = [absolutePath];
	if (input.rename) {
		const destPath = resolvePath(input.rename);
		if (destPath !== absolutePath) mutationPaths.push(destPath);
	}
	// The cross-process lock creates missing parent directories for `<path>.lock`.
	// Check every locked create/move path, including a rename on create, first.
	await preflightPatchMkdir(input, options);
	const usingDefaultFs = options.fs === undefined || options.fs === defaultFileSystem;
	// dryRun/preview must stay read-only: never create durable `<path>.lock` dirs
	// (would fail on read-only parents and mutate the FS during preview) (#2900 review).
	const crossProcess = options.dryRun === true ? false : (options.crossProcessLock ?? usingDefaultFs);
	return withEditPathMutation(mutationPaths, () => applyNormalizedPatch(input, options), { crossProcess });
}

/** Read-only mkdir check for one patch hunk. Does not create directories. */
export async function preflightPatchMkdir(input: PatchInput, options: ApplyPatchOptions): Promise<void> {
	const resolvePath = (p: string): string => resolveToCwd(p, options.cwd);
	const absolutePath = resolvePath(input.path);
	const op = input.op ?? "update";
	if (op === "create") {
		await rejectPatchMkdirEscape(options.cwd, absolutePath, options.localRoot, input.path, options.signal);
	}
	if (input.rename) {
		const destPath = resolvePath(input.rename);
		if (destPath !== absolutePath) {
			// The source is locked too. Check it before that lock can mkdir through a symlink.
			await rejectPatchMkdirEscape(options.cwd, absolutePath, options.localRoot, input.path, options.signal);
			await rejectPatchMkdirEscape(options.cwd, destPath, options.localRoot, input.rename, options.signal);
		}
	}
}

async function rejectPatchMkdirEscape(
	cwd: string,
	absolutePath: string,
	localRoot: string | undefined,
	displayPath: string,
	signal?: AbortSignal,
): Promise<void> {
	const parentDir = path.dirname(absolutePath);
	if (!parentDir || parentDir === ".") return;
	await resolvePatchMkdirPath(cwd, absolutePath, localRoot, parentDir, displayPath, signal);
}

/**
 * Apply a normalized patch operation to the filesystem.
 * Caller must already hold path mutation rights when concurrent writers exist.
 * @internal
 */
async function applyNormalizedPatch(input: PatchInput, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	const {
		cwd,
		dryRun = false,
		fs = defaultFileSystem,
		fuzzyThreshold = DEFAULT_FUZZY_THRESHOLD,
		allowFuzzy = true,
		localRoot,
		signal,
	} = options;

	const resolvePath = (p: string): string => resolveToCwd(p, cwd);
	const absolutePath = resolvePath(input.path);
	const op = input.op ?? "update";

	if (input.rename) {
		const destPath = resolvePath(input.rename);
		if (destPath === absolutePath) {
			throw new ApplyPatchError("rename path is the same as source path");
		}
	}

	// Handle CREATE operation
	if (op === "create") {
		if (!input.diff) {
			throw new ApplyPatchError("Create operation requires diff (file content)");
		}
		// Strip + prefixes if present (handles diffs formatted as additions)
		const normalizedContent = normalizeCreateContent(input.diff);
		const content = normalizedContent.endsWith("\n") ? normalizedContent : `${normalizedContent}\n`;

		const parentDir = path.dirname(absolutePath);
		const mkdirPath =
			parentDir && parentDir !== "."
				? await resolvePatchMkdirPath(cwd, absolutePath, localRoot, parentDir, input.path, signal)
				: undefined;
		if (!dryRun) {
			if (mkdirPath) {
				signal?.throwIfAborted();
				await fs.mkdir(mkdirPath);
			}
			signal?.throwIfAborted();
			await fs.write(absolutePath, content);
		}

		return {
			change: {
				type: "create",
				path: absolutePath,
				newContent: content,
			},
		};
	}

	// Handle DELETE operation
	if (op === "delete") {
		signal?.throwIfAborted();
		const boundary = boundaryForPatchDelete(cwd, absolutePath, localRoot);
		const deletePath = await resolvePatchDeletePath(boundary, absolutePath, input.path, signal);
		signal?.throwIfAborted();
		const oldContent = await readExistingPatchFile(fs, deletePath, input.path);
		signal?.throwIfAborted();
		if (!dryRun) {
			await fs.delete(deletePath);
		}

		return {
			change: {
				type: "delete",
				path: absolutePath,
				oldContent,
			},
		};
	}

	// Handle UPDATE operation
	if (!input.diff) {
		throw new ApplyPatchError("Update operation requires diff (hunks)");
	}

	const originalContent = await readExistingPatchFile(fs, absolutePath, input.path);
	const { bom: bomFromText, text: strippedContent } = stripBom(originalContent);
	let bom = bomFromText;
	if (!bom && fs.readBinary) {
		const bytes = await fs.readBinary(absolutePath);
		if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
			bom = "\uFEFF";
		}
	}
	const lineEnding = detectLineEnding(strippedContent);
	const normalizedContent = normalizeToLF(strippedContent);
	const { content: newContent, warnings } = await applyPatchText(
		normalizedContent,
		input.path,
		input.diff,
		fuzzyThreshold,
		allowFuzzy,
	);
	const finalContent = bom + restoreLineEndings(newContent, lineEnding);
	const destPath = input.rename ? resolvePath(input.rename) : absolutePath;
	const isMove = Boolean(input.rename) && destPath !== absolutePath;
	let moveParent: string | undefined;
	if (isMove) {
		const parentDir = path.dirname(destPath);
		if (parentDir && parentDir !== ".") {
			moveParent = await resolvePatchMkdirPath(
				cwd,
				destPath,
				localRoot,
				parentDir,
				input.rename ?? input.path,
				signal,
			);
		}
	}

	if (!dryRun) {
		// Commit-time CAS: reject if another writer mutated the file after our
		// authoritative read (e.g. a process that did not take the path lock).
		const commitContent = await readExistingPatchFile(fs, absolutePath, input.path);
		if (commitContent !== originalContent) {
			throw new ApplyPatchError(`concurrent edit conflict: file changed since read: ${input.path}`);
		}
		if (isMove) {
			// Preflight can pass, then another writer holding this lock can
			// turn a handwritten destination into a generated file.
			if (options.destinationGuard) {
				signal?.throwIfAborted();
				await assertEditableFile(destPath, options.destinationGuard.displayPath, options.destinationGuard.settings);
				signal?.throwIfAborted();
			}
			if (moveParent) {
				signal?.throwIfAborted();
				await fs.mkdir(moveParent);
			}
			signal?.throwIfAborted();
			await fs.write(destPath, finalContent);
			await fs.delete(absolutePath);
		} else {
			await fs.write(absolutePath, finalContent);
		}
	}

	return {
		change: {
			type: "update",
			path: absolutePath,
			newPath: isMove ? destPath : undefined,
			oldContent: originalContent,
			newContent: finalContent,
		},
		warnings: warnings.length > 0 ? warnings : undefined,
	};
}

/**
 * Preview what changes a patch would make without applying it.
 */
export async function previewPatch(input: PatchInput, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	return applyPatch(input, { ...options, dryRun: true });
}

export async function computePatchDiff(
	input: PatchInput,
	cwd: string,
	options?: { fuzzyThreshold?: number; allowFuzzy?: boolean },
): Promise<
	| {
			diff: string;
			firstChangedLine: number | undefined;
	  }
	| {
			error: string;
	  }
> {
	try {
		const result = await previewPatch(input, {
			cwd,
			fuzzyThreshold: options?.fuzzyThreshold,
			allowFuzzy: options?.allowFuzzy,
		});
		const oldContent = result.change.oldContent ?? "";
		const newContent = result.change.newContent ?? "";
		const normalizedOld = normalizeToLF(stripBom(oldContent).text);
		const normalizedNew = normalizeToLF(stripBom(newContent).text);
		if (!normalizedOld && !normalizedNew) {
			return { diff: "", firstChangedLine: undefined };
		}
		return generateUnifiedDiffString(normalizedOld, normalizedNew);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

export const patchEditEntrySchema = z
	.object({
		op: z.enum(["create", "delete", "update"]).optional().describe("operation (default update)"),
		rename: z.string().describe("new path for move").optional(),
		diff: z.string().describe("diff hunks or full content for create").optional(),
	})
	.strict();

export const patchEditSchema = z
	.object({
		path: z.string().describe("file path"),
		edits: z.array(patchEditEntrySchema).min(1).describe("patch operations"),
	})
	.strict();

export type PatchEditEntry = z.infer<typeof patchEditEntrySchema>;
export type PatchParams = z.infer<typeof patchEditSchema>;

export interface ExecutePatchSingleOptions {
	session: ToolSession;
	path: string;
	params: PatchEditEntry;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

class LspFileSystem implements FileSystem {
	#lastDiagnostics: FileDiagnosticsResult | undefined;
	#fileCache: Record<string, Bun.BunFile> = {};

	constructor(
		private readonly writethrough: WritethroughCallback,
		private readonly signal?: AbortSignal,
		private readonly batchRequest?: LspBatchRequest,
		private readonly deferredForPath?: (path: string) => WritethroughDeferredHandle,
	) {}

	#getFile(path: string): Bun.BunFile {
		if (this.#fileCache[path]) {
			return this.#fileCache[path];
		}
		const file = Bun.file(path);
		this.#fileCache[path] = file;
		return file;
	}

	async exists(path: string): Promise<boolean> {
		return this.#getFile(path).exists();
	}

	async read(path: string): Promise<string> {
		return readEditFileText(path, path);
	}

	async readBinary(path: string): Promise<Uint8Array> {
		const bytes = await fs.promises.readFile(path);
		return bytes;
	}

	async write(path: string, content: string): Promise<void> {
		const file = this.#getFile(path);
		const finalContent = await serializeEditFileText(path, path, content);
		const deferredForPath = this.deferredForPath;
		const result = await this.writethrough(
			path,
			finalContent,
			this.signal,
			file,
			this.batchRequest,
			deferredForPath ? (dst: string) => deferredForPath(dst) : undefined,
		);
		if (result) {
			this.#lastDiagnostics = result;
		}
	}

	async delete(path: string): Promise<void> {
		await this.#getFile(path).unlink();
	}

	async mkdir(path: string): Promise<void> {
		await fs.promises.mkdir(path, { recursive: true });
	}

	getDiagnostics(): FileDiagnosticsResult | undefined {
		return this.#lastDiagnostics;
	}
}

function mergeDiagnosticsWithWarnings(
	diagnostics: FileDiagnosticsResult | undefined,
	warnings: string[],
): FileDiagnosticsResult | undefined {
	if (warnings.length === 0) return diagnostics;
	const warningMessages = warnings.map(warning => `patch: ${warning}`);
	if (!diagnostics) {
		return {
			server: "patch",
			messages: warningMessages,
			summary: `Patch warnings: ${warnings.length}`,
			errored: false,
		};
	}
	return {
		...diagnostics,
		messages: [...warningMessages, ...diagnostics.messages],
		summary: `${diagnostics.summary}; Patch warnings: ${warnings.length}`,
	};
}

export async function executePatchSingle(
	options: ExecutePatchSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof patchEditEntrySchema>> {
	const {
		session,
		path,
		params,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;
	const { op: rawOp, rename, diff } = params;

	const op: Operation = rawOp === "create" || rawOp === "delete" ? rawOp : "update";

	enforcePlanModeWrite(session, path, { op, move: rename });
	const resolvedPath = resolvePlanPath(session, path);
	const resolvedRename = rename ? resolvePlanPath(session, rename) : undefined;

	signal?.throwIfAborted();
	await assertEditableFile(resolvedPath, path, session.settings);
	// The rename destination is the path that is written. The source call above
	// already uses this helper, including generated names that do not exist yet.
	signal?.throwIfAborted();
	if (resolvedRename && rename && resolvedRename !== resolvedPath) {
		await assertEditableFile(resolvedRename, rename, session.settings);
		signal?.throwIfAborted();
	}

	// Capture pre-edit content so we can verify the write actually hit disk.
	// `LspFileSystem.writeFile` delegates to a writethrough callback that, in
	// some host integrations, has been observed to report success without
	// persisting bytes — leaving the tool to claim "Updated <path>" while the
	// file on disk is byte-identical to before. After the write we re-read
	// the file and assert the bytes match the expected newContent; relying
	// on stat (mtime/size) is unreliable because filesystems with coarse
	// timestamp resolution can record an unchanged mtime even when the
	// content was rewritten, and same-length rewrites leave size unchanged.
	let preEditContent: Uint8Array | undefined;
	if (op === "update") {
		try {
			preEditContent = await fs.promises.readFile(resolvedPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	const input: PatchInput = { path: resolvedPath, op, rename: resolvedRename, diff };
	const patchFileSystem = new LspFileSystem(writethrough, signal, batchRequest, beginDeferredDiagnosticsForPath);
	// Production edit path uses LspFileSystem (disk-backed writethrough), which is
	// not `defaultFileSystem` by object identity. Force durable cross-process
	// locking so multi-process agents cannot silently race past the path mutex
	// (#2900 review: do not infer lock capability from FileSystem identity).
	const localRoot = explicitLocalRootForSession(session);
	const result = await applyPatch(input, {
		cwd: session.cwd,
		fs: patchFileSystem,
		fuzzyThreshold,
		allowFuzzy,
		crossProcessLock: true,
		localRoot,
		signal,
		...(op === "update" && resolvedRename && rename && resolvedRename !== resolvedPath
			? { destinationGuard: { settings: session.settings, displayPath: rename } }
			: {}),
	});

	// Post-write verification: only meaningful for in-place updates where the
	// patch actually changes content and the file is not being renamed away.
	if (
		result.change.type === "update" &&
		!result.change.newPath &&
		preEditContent !== undefined &&
		result.change.oldContent !== undefined &&
		result.change.newContent !== undefined &&
		result.change.oldContent !== result.change.newContent
	) {
		let postEditContent: Uint8Array | undefined;
		try {
			postEditContent = await fs.promises.readFile(resolvedPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		const unchanged =
			postEditContent !== undefined &&
			postEditContent.length === preEditContent.length &&
			postEditContent.every((b, i) => b === preEditContent[i]);
		if (unchanged) {
			throw new ToolError(`edit appeared successful but file content did not change on disk: ${resolvedPath}`, {
				path: resolvedPath,
			});
		}
	}

	if (resolvedRename) {
		invalidateFsScanAfterRename(resolvedPath, resolvedRename);
	} else if (result.change.type === "delete") {
		invalidateFsScanAfterDelete(resolvedPath);
	} else {
		invalidateFsScanAfterWrite(resolvedPath);
	}
	const effectiveRename = result.change.newPath ? rename : undefined;

	let diffResult: { diff: string; firstChangedLine: number | undefined } = {
		diff: "",
		firstChangedLine: undefined,
	};
	if (result.change.type === "update" && result.change.oldContent && result.change.newContent) {
		const normalizedOld = normalizeToLF(stripBom(result.change.oldContent).text);
		const normalizedNew = normalizeToLF(stripBom(result.change.newContent).text);
		diffResult = generateUnifiedDiffString(normalizedOld, normalizedNew);
	}

	let resultText: string;
	switch (result.change.type) {
		case "create":
			resultText = `Created ${path}`;
			break;
		case "delete":
			resultText = `Deleted ${path}`;
			break;
		case "update":
			resultText = effectiveRename ? `Updated and moved ${path} to ${effectiveRename}` : `Updated ${path}`;
			break;
	}

	let diagnostics = patchFileSystem.getDiagnostics();
	if (op === "delete" && batchRequest?.flush) {
		const flushedDiagnostics = await flushLspWritethroughBatch(batchRequest.id, session.cwd, signal);
		diagnostics ??= flushedDiagnostics;
	}
	const mergedDiagnostics = mergeDiagnosticsWithWarnings(diagnostics, result.warnings ?? []);
	const meta = outputMeta()
		.diagnostics(mergedDiagnostics?.summary ?? "", mergedDiagnostics?.messages ?? [])
		.get();

	const oldText = result.change.type !== "create" ? result.change.oldContent : undefined;
	const newText = result.change.type !== "delete" ? result.change.newContent : undefined;

	return {
		content: [{ type: "text", text: resultText }],
		details: {
			diff: diffResult.diff,
			// When the patch moves the file, anchor the diff to the destination
			// path. ACP `ToolCallContent.diff.path` comes from this field, and
			// clients use it to open or focus the file post-change; pointing at
			// the (now-deleted) source navigates to nothing.
			path: result.change.newPath ?? resolvedPath,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics: mergedDiagnostics,
			op,
			move: effectiveRename,
			meta,
			oldText,
			newText,
		},
	};
}
