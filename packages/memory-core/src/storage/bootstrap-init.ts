import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { InitMemoryRootResult } from "../index";

const MEMORY_MAP_CONTENT = [
	"# Memory Map",
	"",
	"<!-- AUTO:PROJECTS START -->",
	"<!-- AUTO:PROJECTS END -->",
	"",
	"<!-- AUTO:INDEX-HEALTH START -->",
	"<!-- AUTO:INDEX-HEALTH END -->",
	"",
].join("\n");
const CONFIG_CONTENT = "version: 1\n";
const ROUTES_CONTENT = "version: 1\nroutes: {}\n";
const REGISTRY_CONTENT = "version: 1\nprojects: {}\n";

type ScaffoldEntry =
	| { readonly relPath: string; readonly kind: "directory" }
	| { readonly relPath: string; readonly kind: "file"; readonly content: string };

const SCAFFOLD = Object.freeze([
	{ relPath: ".journal", kind: "directory" },
	{ relPath: ".locks", kind: "directory" },
	{ relPath: "MEMORY.md", kind: "file", content: MEMORY_MAP_CONTENT },
	{ relPath: "config.yaml", kind: "file", content: CONFIG_CONTENT },
	{ relPath: "global", kind: "directory" },
	{ relPath: "global/archive", kind: "directory" },
	{ relPath: "global/constraints", kind: "directory" },
	{ relPath: "global/conventions", kind: "directory" },
	{ relPath: "global/profile", kind: "directory" },
	{ relPath: "projects", kind: "directory" },
	{ relPath: "projects/registry.yaml", kind: "file", content: REGISTRY_CONTENT },
	{ relPath: "routes.yaml", kind: "file", content: ROUTES_CONTENT },
	{ relPath: "sessions", kind: "directory" },
] as const satisfies readonly ScaffoldEntry[]);

function compareUtf8Paths(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

export type MemoryBootstrapErrorCode =
	| "invalid-root"
	| "root-not-directory"
	| "root-symlink"
	| "root-owner-mismatch"
	| "root-mode-insecure"
	| "scaffold-path-type-mismatch"
	| "scaffold-create-failed"
	| "bootstrap-failed";

const BOOTSTRAP_REASONS: Readonly<Record<MemoryBootstrapErrorCode, string>> = Object.freeze({
	"invalid-root": "memory root must be an absolute path",
	"root-not-directory": "memory root is not a directory",
	"root-symlink": "memory root must not be a symlink",
	"root-owner-mismatch": "memory root owner does not match the current user",
	"root-mode-insecure": "memory root mode must be 0700",
	"scaffold-path-type-mismatch": "scaffold path has an unsafe type",
	"scaffold-create-failed": "memory scaffold could not be created",
	"bootstrap-failed": "memory root initialization failed",
});

export class MemoryBootstrapError extends Error {
	readonly code: MemoryBootstrapErrorCode;
	readonly reason: string;

	constructor(code: MemoryBootstrapErrorCode, cause?: unknown) {
		const reason = BOOTSTRAP_REASONS[code];
		super(reason, { cause });
		this.name = "MemoryBootstrapError";
		this.code = code;
		this.reason = reason;
	}
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function bootstrapError(code: MemoryBootstrapErrorCode, cause?: unknown): MemoryBootstrapError {
	return new MemoryBootstrapError(code, cause);
}

function scaffoldPath(rootPath: string, relPath: string): string {
	return path.join(rootPath, ...relPath.split("/"));
}

function resolvedRootPath(rootPath: string): string {
	if (
		typeof rootPath !== "string" ||
		rootPath.length === 0 ||
		rootPath.includes("\u0000") ||
		!path.isAbsolute(rootPath)
	) {
		throw bootstrapError("invalid-root");
	}
	return path.resolve(rootPath);
}

async function existingPath(filePath: string): Promise<Stats | null> {
	try {
		return await fs.lstat(filePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

function hasExpectedOwner(stats: Stats): boolean {
	if (process.platform === "win32") return true;
	const getuid = process.getuid;
	return typeof getuid === "function" && stats.uid === getuid();
}

async function hasWritableAncestorWithoutStickyBit(rootPath: string): Promise<boolean> {
	if (process.platform === "win32") return false;
	let current = path.dirname(rootPath);
	for (;;) {
		const stats = await fs.lstat(current);
		const mode = stats.mode & 0o7777;
		if ((mode & 0o22) !== 0 && (mode & 0o1000) === 0) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

async function validateRootSecurity(rootPath: string, stats: Stats): Promise<string> {
	if (stats.isSymbolicLink()) throw bootstrapError("root-symlink");
	if (!stats.isDirectory()) throw bootstrapError("root-not-directory");
	let canonicalPath: string;
	try {
		canonicalPath = await fs.realpath(rootPath);
	} catch (error) {
		throw bootstrapError("bootstrap-failed", error);
	}
	if (process.platform === "win32") return canonicalPath;
	if (!hasExpectedOwner(stats)) throw bootstrapError("root-owner-mismatch");
	if ((stats.mode & 0o7777) !== 0o700) throw bootstrapError("root-mode-insecure");
	try {
		if (await hasWritableAncestorWithoutStickyBit(canonicalPath)) throw bootstrapError("root-mode-insecure");
	} catch (error) {
		if (error instanceof MemoryBootstrapError) throw error;
		throw bootstrapError("bootstrap-failed", error);
	}
	return canonicalPath;
}

async function ensureRoot(rootPath: string): Promise<string> {
	const existing = await existingPath(rootPath);
	if (existing !== null) return validateRootSecurity(rootPath, existing);
	try {
		await fs.mkdir(rootPath, { mode: 0o700 });
		await fs.chmod(rootPath, 0o700);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw bootstrapError("bootstrap-failed", error);
		const raced = await existingPath(rootPath);
		if (raced === null) throw bootstrapError("bootstrap-failed");
		return validateRootSecurity(rootPath, raced);
	}
	const created = await existingPath(rootPath);
	if (created === null) throw bootstrapError("bootstrap-failed");
	return validateRootSecurity(rootPath, created);
}

async function ensureDirectory(rootPath: string, relPath: string): Promise<boolean> {
	const directoryPath = scaffoldPath(rootPath, relPath);
	const existing = await existingPath(directoryPath);
	if (existing !== null) {
		if (existing.isSymbolicLink() || !existing.isDirectory()) throw bootstrapError("scaffold-path-type-mismatch");
		return false;
	}
	try {
		await fs.mkdir(directoryPath, { mode: 0o700 });
		await fs.chmod(directoryPath, 0o700);
		return true;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw bootstrapError("scaffold-create-failed", error);
		const raced = await existingPath(directoryPath);
		if (raced === null) throw bootstrapError("scaffold-create-failed");
		if (raced.isSymbolicLink() || !raced.isDirectory()) throw bootstrapError("scaffold-path-type-mismatch");
		return false;
	}
}

async function ensureFile(rootPath: string, relPath: string, content: string): Promise<boolean> {
	const filePath = scaffoldPath(rootPath, relPath);
	const existing = await existingPath(filePath);
	if (existing !== null) {
		if (existing.isSymbolicLink() || !existing.isFile()) throw bootstrapError("scaffold-path-type-mismatch");
		return false;
	}

	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(filePath, "wx", 0o600);
		const bytes = Buffer.from(content, "utf8");
		const written = await handle.write(bytes, 0, bytes.byteLength, null);
		if (written.bytesWritten !== bytes.byteLength) throw bootstrapError("scaffold-create-failed");
		await handle.sync();
		await handle.chmod(0o600);
		await handle.close();
		handle = undefined;
		return true;
	} catch (error) {
		if (handle !== undefined) {
			await handle.close().catch(() => undefined);
		}
		if (error instanceof MemoryBootstrapError) throw error;
		if (errorCode(error) === "EEXIST") {
			const raced = await existingPath(filePath);
			if (raced?.isFile() && !raced.isSymbolicLink()) return false;
			if (raced !== null) throw bootstrapError("scaffold-path-type-mismatch");
		}
		throw bootstrapError("scaffold-create-failed", error);
	}
}

/**
 * Create the fixed, empty memory store. This is the sole writer allowed to
 * create a path before a memory root exists; all paths and bytes are literals.
 */
export async function createMemoryRootScaffold(rootPath: string): Promise<InitMemoryRootResult> {
	try {
		const resolvedRoot = resolvedRootPath(rootPath);
		const memoryRoot = await ensureRoot(resolvedRoot);

		const created: string[] = [];
		const alreadyPresent: string[] = [];
		for (const entry of SCAFFOLD) {
			const wasCreated =
				entry.kind === "directory"
					? await ensureDirectory(memoryRoot, entry.relPath)
					: await ensureFile(memoryRoot, entry.relPath, entry.content);
			if (wasCreated) created.push(entry.relPath);
			else alreadyPresent.push(entry.relPath);
		}
		created.sort(compareUtf8Paths);
		alreadyPresent.sort(compareUtf8Paths);
		return Object.freeze({
			schemaVersion: "gajae.memory.init-receipt.v1",
			memoryRoot,
			created: Object.freeze(created),
			alreadyPresent: Object.freeze(alreadyPresent),
		});
	} catch (error) {
		if (error instanceof MemoryBootstrapError) throw error;
		throw bootstrapError("bootstrap-failed", error);
	}
}
