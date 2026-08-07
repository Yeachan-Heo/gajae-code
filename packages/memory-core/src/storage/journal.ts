import * as crypto from "node:crypto";
import type { Stats } from "node:fs";
import * as fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type MemoryEnvironment, validateMemoryEnvironment } from "../env";
import { MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import type { WriteDestination } from "../index";
import { authorizeAccess, verifyAccessGrant } from "../policy/access-policy";
import {
	assertPathBinding,
	assertRootBinding,
	type ContainedPath,
	containPath,
	pinMemoryRoot,
	type RootPin,
} from "../policy/path-safety";
import { sortMemoryLockPaths, withMemoryWriteLocks } from "./locks";
import { openVerifiedFile, publishVerified, VerifiedStorageError } from "./verified-open";

export interface JournalEntry {
	readonly relPath: string;
	readonly expectedDigest: string | null;
	readonly postDigest: string;
	readonly tempPath: string;
}

export interface MemoryJournal {
	readonly schemaVersion: "gajae.memory.journal.v1";
	readonly mutationId: string;
	readonly entries: readonly JournalEntry[];
}

export type Journal = MemoryJournal;

export type JournalProgressKind = "stage" | "publish-begin" | "publish-end" | "commit";

export type JournalProgress =
	| { readonly kind: "stage"; readonly index: number }
	| { readonly kind: "publish-begin"; readonly index: number }
	| { readonly kind: "publish-end"; readonly index: number }
	| { readonly kind: "commit" };

export class MemoryJournalError extends Error {
	readonly code = "lock-conflict" as const;
	readonly exitCode = 12 as const;
	readonly relPath: string;

	constructor(relPath: string, detail: string) {
		super(detail);
		this.name = "MemoryJournalError";
		this.relPath = relPath;
	}
}

export const MEMORY_JOURNAL_SCHEMA_VERSION = "gajae.memory.journal.v1" as const;
const JOURNAL_SCHEMA_VERSION = MEMORY_JOURNAL_SCHEMA_VERSION;
const NOFOLLOW = process.platform === "win32" ? 0 : (fsSync.constants.O_NOFOLLOW ?? 0);

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMutationId(mutationId: string): string {
	if (
		typeof mutationId !== "string" ||
		mutationId.length === 0 ||
		mutationId.length > 200 ||
		mutationId.includes("\u0000") ||
		mutationId.includes("/") ||
		mutationId.includes("\\") ||
		mutationId === "." ||
		mutationId === ".."
	) {
		throw new MemoryJournalError(String(mutationId), "journal mutation id is malformed");
	}
	return mutationId.normalize("NFC");
}

function normalizeRelPath(relPath: string): string {
	if (typeof relPath !== "string" || relPath.length === 0 || relPath.includes("\u0000") || relPath.includes("\\")) {
		throw new MemoryJournalError(String(relPath), "journal relative path is malformed");
	}
	const normalized = relPath.normalize("NFC");
	if (path.posix.isAbsolute(normalized))
		throw new MemoryJournalError(relPath, "journal relative path must be relative");
	const components = normalized.split("/");
	if (components.some(component => component.length === 0 || component === "." || component === "..")) {
		throw new MemoryJournalError(relPath, "journal relative path contains an unsafe component");
	}
	return normalized;
}

function normalizeTempPath(tempPath: string, relPath: string): string {
	if (
		typeof tempPath !== "string" ||
		tempPath.length === 0 ||
		tempPath.includes("\u0000") ||
		/[\r\n]/.test(tempPath)
	) {
		throw new MemoryJournalError(relPath, "journal temp path is malformed");
	}
	let normalized: string;
	try {
		normalized = normalizeRelPath(tempPath);
	} catch (error) {
		if (error instanceof MemoryJournalError) throw new MemoryJournalError(relPath, "journal temp path is malformed");
		throw error;
	}
	// A temp must live in the journal's own namespace. Without this, a tampered or
	// corrupt plan could name a canonical document as its `tempPath`; recovery
	// cleanup would then unlink real memory content and report completion.
	if (!normalized.startsWith(".journal/") || normalized === relPath) {
		throw new MemoryJournalError(relPath, "journal temp path is malformed");
	}
	return normalized;
}

function normalizeDigest(value: unknown, allowNull: boolean, relPath: string): string | null {
	if (allowNull && value === null) return null;
	if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
		throw new MemoryJournalError(relPath, "journal digest is malformed");
	}
	return value;
}

function normalizeEntry(value: unknown): JournalEntry {
	if (!isRecord(value)) throw new MemoryJournalError(".journal", "journal entry is malformed");
	const relPath = normalizeRelPath(value.relPath as string);
	return {
		relPath,
		expectedDigest: normalizeDigest(value.expectedDigest, true, relPath),
		postDigest: normalizeDigest(value.postDigest, false, relPath) as string,
		tempPath: normalizeTempPath(value.tempPath as string, relPath),
	};
}

function normalizeJournal(value: unknown, expectedMutationId: string | null, relPath: string): MemoryJournal {
	if (!isRecord(value) || value.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
		throw new MemoryJournalError(relPath, "journal schema is unsupported or malformed");
	}
	const mutationId = normalizeMutationId(value.mutationId as string);
	if (expectedMutationId !== null && mutationId !== expectedMutationId) {
		throw new MemoryJournalError(relPath, "journal mutation id does not match its path");
	}
	if (!Array.isArray(value.entries)) throw new MemoryJournalError(relPath, "journal entries are malformed");
	const entries = value.entries.map(normalizeEntry);
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.relPath)) throw new MemoryJournalError(entry.relPath, "journal contains duplicate paths");
		seen.add(entry.relPath);
	}
	return Object.freeze({
		schemaVersion: JOURNAL_SCHEMA_VERSION,
		mutationId,
		entries: Object.freeze(entries),
	});
}

function normalizeRootPath(rootPath: string, relPath: string): string {
	if (
		typeof rootPath !== "string" ||
		rootPath.length === 0 ||
		rootPath.includes("\u0000") ||
		!path.isAbsolute(rootPath)
	) {
		throw new MemoryJournalError(relPath, "memory root must be an absolute path");
	}
	return path.resolve(rootPath);
}

interface JournalDirectoryBinding {
	readonly root: RootPin;
	readonly directory: ContainedPath;
}

function sameIdentity(
	left: { readonly dev: bigint; readonly ino: bigint },
	right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function journalDirectoryBinding(rootPath: string, relPath: string): JournalDirectoryBinding {
	const normalizedRoot = normalizeRootPath(rootPath, relPath);
	const rootResult = pinMemoryRoot(normalizedRoot);
	if (!rootResult.ok) throw new MemoryJournalError(relPath, "memory root binding could not be verified");
	const directoryResult = containPath(rootResult.value, ".journal");
	if (!directoryResult.ok || directoryResult.value.leafIdentity === null) {
		throw new MemoryJournalError(relPath, "journal root is not a directory");
	}
	let stat: fsSync.BigIntStats;
	try {
		stat = fsSync.lstatSync(directoryResult.value.absolutePath, {
			bigint: true,
		});
	} catch (error) {
		throw memoryJournalError(relPath, "journal root could not be inspected", error);
	}
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.dev !== rootResult.value.dev ||
		!sameIdentity(stat, directoryResult.value.leafIdentity)
	) {
		throw new MemoryJournalError(relPath, "journal root is not a trusted directory");
	}
	return Object.freeze({
		root: rootResult.value,
		directory: directoryResult.value,
	});
}

function assertJournalDirectoryBinding(binding: JournalDirectoryBinding, relPath: string): void {
	const rootBinding = assertRootBinding(binding.root);
	if (!rootBinding.ok) throw new MemoryJournalError(relPath, "memory root binding changed");
	const rebound = containPath(binding.root, ".journal");
	if (!rebound.ok || rebound.value.leafIdentity === null) {
		throw new MemoryJournalError(relPath, "journal root binding changed");
	}
	const boundDirectory = binding.directory.leafIdentity;
	if (
		boundDirectory === null ||
		rebound.value.absolutePath !== binding.directory.absolutePath ||
		!sameIdentity(rebound.value.leafIdentity, boundDirectory)
	) {
		throw new MemoryJournalError(relPath, "journal root binding changed");
	}
	let stat: fsSync.BigIntStats;
	try {
		stat = fsSync.lstatSync(rebound.value.absolutePath, { bigint: true });
	} catch (error) {
		throw memoryJournalError(relPath, "journal root binding could not be inspected", error);
	}
	const directoryIdentity = binding.directory.leafIdentity;
	if (
		directoryIdentity === null ||
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.dev !== binding.root.dev ||
		!sameIdentity(stat, directoryIdentity)
	) {
		throw new MemoryJournalError(relPath, "journal root binding changed");
	}
}

function admittedJournalArtifact(
	rootPath: string,
	artifactRelPath: string,
	relPath: string,
): {
	readonly binding: JournalDirectoryBinding;
	readonly contained: ContainedPath;
} {
	const binding = journalDirectoryBinding(rootPath, relPath);
	const containedResult = containPath(binding.root, artifactRelPath);
	if (!containedResult.ok)
		throw new MemoryJournalError(relPath, "journal artifact is not contained by the memory root");
	assertJournalDirectoryBinding(binding, relPath);
	return { binding, contained: containedResult.value };
}

function existingJournalArtifact(rootPath: string, artifactRelPath: string, relPath: string): Stats | null {
	const admitted = admittedJournalArtifact(rootPath, artifactRelPath, relPath);
	let stat: Stats | null;
	try {
		stat = fsSync.lstatSync(admitted.contained.absolutePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") stat = null;
		else throw memoryJournalError(relPath, "journal artifact could not be inspected", error);
	}
	assertJournalDirectoryBinding(admitted.binding, relPath);
	return stat;
}

async function ensureJournalDirectory(rootPath: string, relPath: string): Promise<string> {
	const normalizedRoot = normalizeRootPath(rootPath, relPath);
	const rootResult = pinMemoryRoot(normalizedRoot);
	if (!rootResult.ok) throw new MemoryJournalError(relPath, "memory root binding could not be verified");
	const root = rootResult.value;
	const existing = containPath(root, ".journal");
	if (existing.ok && existing.value.leafIdentity !== null) {
		const binding = journalDirectoryBinding(root.canonicalPath, relPath);
		assertJournalDirectoryBinding(binding, relPath);
		return binding.directory.absolutePath;
	}
	if (!existing.ok) throw new MemoryJournalError(relPath, "journal root could not be inspected");
	const journalDirectory = path.join(root.canonicalPath, ".journal");
	const rootBinding = assertRootBinding(root);
	if (!rootBinding.ok) throw new MemoryJournalError(relPath, "memory root binding changed");
	try {
		await fs.mkdir(journalDirectory, { mode: 0o700 });
		const afterMkdir = assertRootBinding(root);
		if (!afterMkdir.ok) throw new MemoryJournalError(relPath, "memory root binding changed after journal creation");
		await fs.chmod(journalDirectory, 0o700);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") {
			if (error instanceof MemoryJournalError) throw error;
			throw new MemoryJournalError(relPath, "journal root cannot be created");
		}
	}
	const binding = journalDirectoryBinding(root.canonicalPath, relPath);
	assertJournalDirectoryBinding(binding, relPath);
	return binding.directory.absolutePath;
}

function journalFilePath(rootPath: string, mutationId: string): string {
	return path.join(rootPath, ".journal", `${mutationId}.json`);
}

function journalProgressPath(rootPath: string, mutationId: string): string {
	return path.join(rootPath, ".journal", `${mutationId}.progress`);
}

export function getJournalPath(rootPath: string, mutationId: string): string {
	const normalizedMutationId = normalizeMutationId(mutationId);
	return journalFilePath(normalizeRootPath(rootPath, normalizedMutationId), normalizedMutationId);
}

export function getJournalProgressPath(rootPath: string, mutationId: string): string {
	const normalizedMutationId = normalizeMutationId(mutationId);
	return journalProgressPath(normalizeRootPath(rootPath, normalizedMutationId), normalizedMutationId);
}

function serializeJournal(journal: MemoryJournal): string {
	return `${JSON.stringify({
		schemaVersion: JOURNAL_SCHEMA_VERSION,
		mutationId: journal.mutationId,
		entries: journal.entries.map(entry => ({
			relPath: entry.relPath,
			expectedDigest: entry.expectedDigest,
			postDigest: entry.postDigest,
			tempPath: entry.tempPath,
		})),
	})}\n`;
}

async function writeImmutableJournal(rootPath: string, artifactRelPath: string, journal: MemoryJournal): Promise<void> {
	const relPath = path.basename(artifactRelPath);
	const admitted = admittedJournalArtifact(rootPath, artifactRelPath, relPath);
	let handle: FileHandle | undefined;
	try {
		assertJournalDirectoryBinding(admitted.binding, relPath);
		handle = await fs.open(
			admitted.contained.absolutePath,
			fsSync.constants.O_EXCL | fsSync.constants.O_CREAT | fsSync.constants.O_WRONLY | NOFOLLOW,
			0o600,
		);
		const bytes = Buffer.from(serializeJournal(journal), "utf8");
		const result = await handle.write(bytes, 0, bytes.byteLength, null);
		if (result.bytesWritten !== bytes.byteLength) throw new Error("short journal write");
		await handle.sync();
		await handle.chmod(0o600);
		await handle.close();
		handle = undefined;
		assertJournalDirectoryBinding(admitted.binding, relPath);
	} catch (error) {
		if (handle !== undefined) await handle.close().catch(() => undefined);
		throw error;
	}
}

export function createJournal(rootPath: string, journal: MemoryJournal): Promise<MemoryJournal>;
export function createJournal(
	rootPath: string,
	mutationId: string,
	entries: readonly JournalEntry[],
): Promise<MemoryJournal>;
export async function createJournal(
	rootPath: string,
	journalOrMutationId: MemoryJournal | string,
	entries?: readonly JournalEntry[],
): Promise<MemoryJournal> {
	const mutationId = typeof journalOrMutationId === "string" ? journalOrMutationId : journalOrMutationId.mutationId;
	const normalizedMutationId = normalizeMutationId(mutationId);
	const candidate: unknown =
		typeof journalOrMutationId === "string"
			? {
					schemaVersion: JOURNAL_SCHEMA_VERSION,
					mutationId: normalizedMutationId,
					entries,
				}
			: journalOrMutationId;
	const journal = normalizeJournal(candidate, normalizedMutationId, `${normalizedMutationId}.json`);
	const root = normalizeRootPath(rootPath, journal.mutationId);
	await ensureJournalDirectory(root, journal.mutationId);
	const progressRelPath = journalArtifactRelPath(journal.mutationId, "progress");
	const existingProgress = existingJournalArtifact(root, progressRelPath, `${journal.mutationId}.progress`);
	if (existingProgress !== null)
		throw new MemoryJournalError(`${journal.mutationId}.progress`, "journal progress already exists");
	try {
		await writeImmutableJournal(root, journalArtifactRelPath(journal.mutationId, "json"), journal);
	} catch (error) {
		if (errorCode(error) === "EEXIST")
			throw new MemoryJournalError(`${journal.mutationId}.json`, "journal already exists");
		if (error instanceof MemoryJournalError) throw error;
		throw new MemoryJournalError(
			`${journal.mutationId}.json`,
			`journal creation failed: ${errorCode(error) ?? "write-failed"}`,
		);
	}
	return journal;
}

export async function readJournal(rootPath: string, mutationId: string): Promise<MemoryJournal>;
export async function readJournal(journalPath: string): Promise<MemoryJournal>;
export async function readJournal(rootOrJournalPath: string, mutationId?: string): Promise<MemoryJournal> {
	let requestedMutationId: string | null = null;
	let filePath = rootOrJournalPath;
	let relPath = path.basename(filePath);
	let containedBytes: Buffer | null = null;
	if (mutationId !== undefined) {
		const normalizedMutationId = normalizeMutationId(mutationId);
		requestedMutationId = normalizedMutationId;
		const root = normalizeRootPath(rootOrJournalPath, normalizedMutationId);
		filePath = journalFilePath(root, normalizedMutationId);
		relPath = `${normalizedMutationId}.json`;
		containedBytes = readContainedBytes(root, journalArtifactRelPath(normalizedMutationId, "json"));
	}

	let raw: string;
	try {
		if (containedBytes !== null) raw = containedBytes.toString("utf8");
		else if (mutationId !== undefined) throw new MemoryJournalError(relPath, "journal read failed: not-found");
		else raw = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (error instanceof MemoryJournalError) throw error;
		throw new MemoryJournalError(relPath, `journal read failed: ${errorCode(error) ?? "read-failed"}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new MemoryJournalError(relPath, "journal JSON is malformed");
	}
	return normalizeJournal(parsed, requestedMutationId, relPath);
}

function progressLine(progress: JournalProgress): string {
	if (progress.kind === "commit") return "commit\n";
	if (!Number.isSafeInteger(progress.index) || progress.index < 0)
		throw new MemoryJournalError(".progress", "journal progress index is invalid");
	return `${progress.kind} ${progress.index}\n`;
}

function parseProgressKind(kind: string, index: number | undefined): JournalProgress {
	if (kind === "commit") {
		if (index !== undefined) throw new MemoryJournalError(".progress", "commit progress cannot carry an index");
		return { kind: "commit" };
	}
	if (kind !== "stage" && kind !== "publish-begin" && kind !== "publish-end") {
		throw new MemoryJournalError(".progress", "journal progress kind is invalid");
	}
	if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
		throw new MemoryJournalError(".progress", "journal progress index is invalid");
	}
	return { kind, index };
}

function rawProgressLine(line: string): string {
	if (!/^(?:stage|publish-begin|publish-end) [0-9]+$/.test(line) && line !== "commit") {
		throw new MemoryJournalError(".progress", "journal progress line is malformed");
	}
	return `${line}\n`;
}

function progressArtifactFromPath(
	progressPath: string,
	relPath: string,
): { readonly root: string; readonly artifactRelPath: string } {
	const absolute = path.resolve(progressPath);
	const root = path.dirname(path.dirname(absolute));
	const artifactRelPath = path.relative(root, absolute).split(path.sep).join("/");
	if (path.basename(path.dirname(absolute)) !== ".journal" || !artifactRelPath.startsWith(".journal/")) {
		throw new MemoryJournalError(relPath, "journal progress path is not rooted in .journal");
	}
	return { root, artifactRelPath };
}

async function appendProgressFile(
	rootPath: string,
	artifactRelPath: string,
	line: string,
	relPath: string,
): Promise<void> {
	const admitted = admittedJournalArtifact(rootPath, artifactRelPath, relPath);
	let handle: FileHandle | undefined;
	try {
		assertJournalDirectoryBinding(admitted.binding, relPath);
		const flags = fsSync.constants.O_APPEND | fsSync.constants.O_CREAT | fsSync.constants.O_WRONLY | NOFOLLOW;
		handle = await fs.open(admitted.contained.absolutePath, flags, 0o600);
		const bytes = Buffer.from(line, "utf8");
		const result = await handle.write(bytes, 0, bytes.byteLength, null);
		if (result.bytesWritten !== bytes.byteLength) throw new Error("short journal progress write");
		await handle.sync();
		await handle.chmod(0o600);
		await handle.close();
		handle = undefined;
		assertJournalDirectoryBinding(admitted.binding, relPath);
	} catch (error) {
		if (handle !== undefined) await handle.close().catch(() => undefined);
		if (error instanceof MemoryJournalError) throw error;
		throw new MemoryJournalError(relPath, `journal progress append failed: ${errorCode(error) ?? "write-failed"}`);
	}
}

export function appendJournalProgress(rootPath: string, mutationId: string, progress: JournalProgress): Promise<void>;
export function appendJournalProgress(rootPath: string, mutationId: string, line: string): Promise<void>;

export function appendJournalProgress(
	rootPath: string,
	mutationId: string,
	kind: JournalProgressKind,
	index?: number,
): Promise<void>;
export function appendJournalProgress(progressPath: string, line: string): Promise<void>;
export async function appendJournalProgress(
	rootOrProgressPath: string,
	mutationOrLine: string,
	progressOrKind?: JournalProgress | string,
	index?: number,
): Promise<void> {
	if (
		progressOrKind === undefined &&
		(/^(?:stage|publish-begin|publish-end) [0-9]+$/.test(mutationOrLine) || mutationOrLine === "commit")
	) {
		const target = progressArtifactFromPath(rootOrProgressPath, path.basename(rootOrProgressPath));
		await appendProgressFile(
			target.root,
			target.artifactRelPath,
			rawProgressLine(mutationOrLine),
			path.basename(rootOrProgressPath),
		);
		return;
	}
	if (progressOrKind === undefined)
		throw new MemoryJournalError(String(mutationOrLine), "journal progress is missing");
	const normalizedMutationId = normalizeMutationId(mutationOrLine);
	const root = normalizeRootPath(rootOrProgressPath, normalizedMutationId);
	await ensureJournalDirectory(root, normalizedMutationId);
	const progressRelPath = journalArtifactRelPath(normalizedMutationId, "progress");
	if (typeof progressOrKind === "string" && /^(?:stage|publish-begin|publish-end) [0-9]+$/.test(progressOrKind)) {
		await appendProgressFile(
			root,
			progressRelPath,
			rawProgressLine(progressOrKind),
			`${normalizedMutationId}.progress`,
		);
		return;
	}
	const progress = typeof progressOrKind === "string" ? parseProgressKind(progressOrKind, index) : progressOrKind;
	await appendProgressFile(root, progressRelPath, progressLine(progress), `${normalizedMutationId}.progress`);
}

export interface JournalRecoveryOutcome {
	readonly mutationId: string;
	readonly state: "complete" | "publishable" | "rollbackable" | "fail-closed";
	readonly relPaths: readonly string[];
}

export type JournalAdmissionMode = "read" | "write" | "doctor";

type JournalAdmissionValue = readonly JournalRecoveryOutcome[];

interface JournalInspection {
	readonly mutationId: string;
	readonly relPaths: readonly string[];
	readonly complete: boolean;
}

export interface JournalMutationHooks {
	readonly afterStage?: (entry: JournalEntry, index: number) => void;
	readonly beforePublish?: (entry: JournalEntry, index: number) => void;
	readonly afterPublish?: (entry: JournalEntry, index: number) => void;
}

type JournalPathState =
	| { readonly kind: "absent" }
	| {
			readonly kind: "file";
			readonly digest: string;
			readonly canonicalDigest: string;
			readonly identity: { readonly dev: bigint; readonly ino: bigint };
	  }
	| { readonly kind: "other" };

function digestBytes(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalDigestBytes(bytes: Uint8Array): string {
	const raw = Buffer.from(bytes);
	const text = raw.toString("utf8");
	const decoded = Buffer.from(text, "utf8");
	if (!decoded.equals(raw)) return digestBytes(raw);
	return digestBytes(Buffer.from(text.replace(/\r\n?/g, "\n").normalize("NFC"), "utf8"));
}

function memoryJournalError(relPath: string, detail: string, cause?: unknown): MemoryJournalError {
	if (cause instanceof MemoryJournalError) return cause;
	if (cause instanceof VerifiedStorageError) return new MemoryJournalError(relPath, cause.reason);
	return new MemoryJournalError(relPath, detail);
}

function admittedPath(
	rootPath: string,
	relPath: string,
): { readonly root: RootPin; readonly contained: ContainedPath } {
	const rootResult = pinMemoryRoot(rootPath);
	if (!rootResult.ok) throw new MemoryJournalError(relPath, "memory root binding could not be verified");
	const containedResult = containPath(rootResult.value, relPath);
	if (!containedResult.ok) throw new MemoryJournalError(relPath, "journal path is not contained by the memory root");
	return { root: rootResult.value, contained: containedResult.value };
}

function pathState(rootPath: string, relPath: string): JournalPathState {
	let admitted: { readonly root: RootPin; readonly contained: ContainedPath };
	try {
		admitted = admittedPath(rootPath, relPath);
	} catch {
		try {
			const root = normalizeRootPath(rootPath, relPath);
			const absolute = path.join(root, ...relPath.split("/"));
			fsSync.lstatSync(absolute, { bigint: true });
			return { kind: "other" };
		} catch (error) {
			if (errorCode(error) === "ENOENT") return { kind: "absent" };
			return { kind: "other" };
		}
	}
	let stat: fsSync.BigIntStats;
	try {
		stat = fsSync.lstatSync(admitted.contained.absolutePath, { bigint: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "absent" };
		return { kind: "other" };
	}
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1n ||
		stat.dev !== admitted.root.dev ||
		admitted.contained.leafIdentity === null ||
		admitted.contained.leafIdentity.dev !== stat.dev ||
		admitted.contained.leafIdentity.ino !== stat.ino
	) {
		return { kind: "other" };
	}
	try {
		const bytes = openVerifiedFile(admitted.root, admitted.contained.relativePath);
		const after = fsSync.lstatSync(admitted.contained.absolutePath, {
			bigint: true,
		});
		if (
			!after.isFile() ||
			after.isSymbolicLink() ||
			after.nlink !== 1n ||
			after.dev !== stat.dev ||
			after.ino !== stat.ino
		) {
			return { kind: "other" };
		}
		return {
			kind: "file",
			digest: digestBytes(bytes),
			canonicalDigest: canonicalDigestBytes(bytes),
			identity: { dev: stat.dev, ino: stat.ino },
		};
	} catch {
		return { kind: "other" };
	}
}

function canonicalPreimagePath(relPath: string): boolean {
	return relPath.endsWith(".md") && relPath !== "MEMORY.md";
}

function expectedMatches(state: JournalPathState, expectedDigest: string | null, relPath: string): boolean {
	if (expectedDigest === null) return state.kind === "absent";
	return (
		state.kind === "file" &&
		(canonicalPreimagePath(relPath) ? state.canonicalDigest : state.digest) === expectedDigest
	);
}

function postMatches(state: JournalPathState, postDigest: string): boolean {
	return state.kind === "file" && state.digest === postDigest;
}

function journalAdmissionLockConflict(relPath: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "lock-conflict",
			exitCode: MEMORY_EXIT_CODES.lockConflict,
			relPath,
		},
	};
}

function journalAdmissionError(error: unknown, fallback = ".journal"): MemoryResult<never> {
	if (error instanceof MemoryJournalError) return journalAdmissionLockConflict(error.relPath);
	if (error !== null && typeof error === "object" && "code" in error) {
		const value = error as {
			readonly code?: unknown;
			readonly relPath?: unknown;
		};
		if (value.code === "lock-conflict" && typeof value.relPath === "string") {
			return journalAdmissionLockConflict(value.relPath);
		}
	}
	return journalAdmissionLockConflict(fallback);
}

function readJournalSync(rootPath: string, mutationId: string): MemoryJournal {
	const normalizedMutationId = normalizeMutationId(mutationId);
	const root = normalizeRootPath(rootPath, normalizedMutationId);
	const relPath = `${normalizedMutationId}.json`;
	const bytes = readContainedBytes(root, journalArtifactRelPath(normalizedMutationId, "json"));
	if (bytes === null) throw new MemoryJournalError(relPath, "journal read failed: not-found");
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new MemoryJournalError(relPath, "journal JSON is malformed");
	}
	return normalizeJournal(parsed, normalizedMutationId, relPath);
}

function readJournalProgressSync(rootPath: string, mutationId: string): readonly JournalProgress[] {
	const normalizedMutationId = normalizeMutationId(mutationId);
	const root = normalizeRootPath(rootPath, normalizedMutationId);
	const bytes = readContainedBytes(root, journalArtifactRelPath(normalizedMutationId, "progress"));
	if (bytes === null || bytes.byteLength === 0) return Object.freeze([]);
	if (bytes.at(-1) !== 0x0a) {
		throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress is truncated");
	}
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) {
		throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress is not valid UTF-8");
	}
	const parsed: JournalProgress[] = [];
	let committed = false;
	for (const line of text.slice(0, -1).split("\n")) {
		if (committed)
			throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress continues after commit");
		if (line === "commit") {
			parsed.push({ kind: "commit" });
			committed = true;
			continue;
		}
		const match = /^(stage|publish-begin|publish-end) ([0-9]+)$/.exec(line);
		if (match === null)
			throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress line is malformed");
		const rawIndex = Number(match[2]);
		if (!Number.isSafeInteger(rawIndex) || rawIndex < 0) {
			throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress index is invalid");
		}
		const kind = match[1];
		if (kind !== "stage" && kind !== "publish-begin" && kind !== "publish-end") {
			throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress kind is invalid");
		}
		parsed.push({ kind, index: rawIndex });
	}
	return Object.freeze(parsed);
}

function inspectJournalSync(rootPath: string, mutationId: string): JournalInspection {
	const journal = readJournalSync(rootPath, mutationId);
	const relPaths = journal.entries.map(entry => entry.relPath);
	let progress: readonly JournalProgress[];
	try {
		progress = readJournalProgressSync(rootPath, mutationId);
	} catch (error) {
		if (error instanceof MemoryJournalError) {
			throw new MemoryJournalError(lockConflictRelPath(relPaths), error.message);
		}
		throw error;
	}
	const durable = parseDurableProgress(progress, journal.entries.length, relPaths);
	const targets = journal.entries.map(entry => pathState(rootPath, entry.relPath));
	const temps = journal.entries.map(entry => pathState(rootPath, entry.tempPath));
	if (
		progress.length === 0 &&
		targets.every((state, index) => postMatches(state, journal.entries[index]?.postDigest ?? ""))
	) {
		const complete = temps.every(
			(state, index) =>
				state.kind === "absent" || (state.kind === "file" && state.digest === journal.entries[index]?.postDigest),
		);
		return Object.freeze({
			mutationId: journal.mutationId,
			relPaths: Object.freeze(relPaths),
			complete,
		});
	}
	let complete = true;
	for (const [index, entry] of journal.entries.entries()) {
		const target = targets[index] ?? { kind: "other" as const };
		const temp = temps[index] ?? { kind: "other" as const };
		const progressState = durable.states[index] ?? "none";
		if (temp.kind === "other" || (temp.kind === "file" && temp.digest !== entry.postDigest)) {
			complete = false;
			continue;
		}
		if (durable.committed || progressState === "publish-end") {
			if (!postMatches(target, entry.postDigest)) complete = false;
			continue;
		}
		if (progressState === "publish-begin") {
			if (!postMatches(target, entry.postDigest)) complete = false;
			continue;
		}
		complete = false;
	}
	return Object.freeze({
		mutationId: journal.mutationId,
		relPaths: Object.freeze(relPaths),
		complete,
	});
}

function journalArtifactRelPath(mutationId: string, suffix: "json" | "progress"): string {
	return `.journal/${mutationId}.${suffix}`;
}

function unlinkContainedPath(rootPath: string, relPath: string): void {
	const state = pathState(rootPath, relPath);
	if (state.kind === "absent") return;
	if (state.kind !== "file") throw new MemoryJournalError(relPath, "journal artifact identity is not trusted");
	const admitted = admittedPath(rootPath, relPath);
	const binding = assertPathBinding(admitted.root, admitted.contained, state.identity);
	if (!binding.ok) throw new MemoryJournalError(relPath, "journal artifact binding changed before unlink");
	try {
		fsSync.unlinkSync(admitted.contained.absolutePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw memoryJournalError(relPath, "journal artifact unlink failed", error);
	}
}

export function removeJournalTemp(rootPath: string, entry: JournalEntry): void {
	unlinkContainedPath(normalizeRootPath(rootPath, entry.relPath), entry.tempPath);
}

export async function removeJournalFiles(rootPath: string, mutationId: string): Promise<void> {
	const normalizedMutationId = normalizeMutationId(mutationId);
	const root = normalizeRootPath(rootPath, normalizedMutationId);
	unlinkContainedPath(root, journalArtifactRelPath(normalizedMutationId, "progress"));
	unlinkContainedPath(root, journalArtifactRelPath(normalizedMutationId, "json"));
	await Promise.resolve();
}

export async function readJournalProgress(rootPath: string, mutationId: string): Promise<readonly JournalProgress[]> {
	const normalizedMutationId = normalizeMutationId(mutationId);
	const root = normalizeRootPath(rootPath, normalizedMutationId);
	const bytes = readContainedBytes(root, journalArtifactRelPath(normalizedMutationId, "progress"));
	if (bytes === null) return Object.freeze([]);
	if (bytes.byteLength === 0) return Object.freeze([]);
	if (bytes.at(-1) !== 0x0a)
		throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress is truncated");
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) {
		throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress is not valid UTF-8");
	}
	const lines = text.slice(0, -1).split("\n");
	const parsed: JournalProgress[] = [];
	let committed = false;
	for (const line of lines) {
		if (committed)
			throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress continues after commit");
		if (line === "commit") {
			parsed.push({ kind: "commit" });
			committed = true;
			continue;
		}
		const match = /^(stage|publish-begin|publish-end) ([0-9]+)$/.exec(line);
		if (match === null)
			throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress line is malformed");
		const rawIndex = Number(match[2]);
		if (!Number.isSafeInteger(rawIndex) || rawIndex < 0) {
			throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress index is invalid");
		}
		const kind = match[1];
		if (kind !== "stage" && kind !== "publish-begin" && kind !== "publish-end") {
			throw new MemoryJournalError(`${normalizedMutationId}.progress`, "journal progress kind is invalid");
		}
		parsed.push({ kind, index: rawIndex });
	}
	return Object.freeze(parsed);
}

export async function stageJournalEntry(
	rootPath: string,
	entry: JournalEntry,
	content: Uint8Array,
	hooks?: JournalMutationHooks,
	index = 0,
): Promise<void> {
	const digest = digestBytes(content);
	if (digest !== entry.postDigest)
		throw new MemoryJournalError(entry.relPath, "staged content does not match journal postimage");
	if (pathState(rootPath, entry.tempPath).kind !== "absent") {
		throw new MemoryJournalError(entry.relPath, "journal temporary path already exists");
	}
	try {
		const receipt = publishVerified(rootPath, entry.tempPath, content);
		if (receipt.digest !== entry.postDigest) {
			throw new MemoryJournalError(entry.relPath, "staged publish digest does not match journal postimage");
		}
	} catch (error) {
		throw memoryJournalError(entry.relPath, "journal stage failed", error);
	}
	hooks?.afterStage?.(entry, index);
}

export async function publishJournalEntry(
	rootPath: string,
	entry: JournalEntry,
	hooks?: JournalMutationHooks,
	index = 0,
): Promise<void> {
	const tempState = pathState(rootPath, entry.tempPath);
	if (tempState.kind !== "file" || tempState.digest !== entry.postDigest) {
		throw new MemoryJournalError(entry.relPath, "journal temp does not match postimage");
	}
	let bytes: Buffer;
	try {
		const admitted = admittedPath(rootPath, entry.tempPath);
		bytes = openVerifiedFile(admitted.root, admitted.contained.relativePath);
	} catch (error) {
		throw memoryJournalError(entry.relPath, "journal temp could not be disclosed", error);
	}
	hooks?.beforePublish?.(entry, index);
	try {
		const receipt = publishVerified(rootPath, entry.relPath, bytes);
		if (receipt.digest !== entry.postDigest)
			throw new MemoryJournalError(entry.relPath, "journal publish digest mismatch");
	} catch (error) {
		throw memoryJournalError(entry.relPath, "journal publish failed", error);
	}
	hooks?.afterPublish?.(entry, index);
}

type DurableEntryProgress = "none" | "stage" | "publish-begin" | "publish-end";

interface RecoveryEntryState {
	readonly entry: JournalEntry;
	readonly progress: DurableEntryProgress;
	readonly target: JournalPathState;
	readonly temp: JournalPathState;
	readonly state: "complete" | "publishable" | "rollbackable" | "fail-closed";
}

function sortedRelPaths(paths: readonly string[]): string[] {
	return sortMemoryLockPaths([...new Set(paths)]);
}

function lockConflictRelPath(paths: readonly string[]): string {
	return sortedRelPaths(paths).join(",");
}

export function writeDestinationForPath(relPath: string): WriteDestination {
	if (relPath.startsWith("global/proposals-")) return "proposal";
	if (relPath.startsWith("projects/")) return "project-canonical";
	if (relPath.startsWith("sessions/")) return "session";
	return "global-canonical";
}

function parseDurableProgress(
	progress: readonly JournalProgress[],
	entryCount: number,
	relPaths: readonly string[],
): {
	readonly states: readonly DurableEntryProgress[];
	readonly committed: boolean;
} {
	const states: DurableEntryProgress[] = new Array<DurableEntryProgress>(entryCount).fill("none");
	let committed = false;
	for (const item of progress) {
		if (item.kind === "commit") {
			if (committed || states.some(state => state !== "publish-end")) {
				throw new MemoryJournalError(lockConflictRelPath(relPaths), "journal commit transition is invalid");
			}
			committed = true;
			continue;
		}
		if (committed || item.index >= entryCount) {
			throw new MemoryJournalError(lockConflictRelPath(relPaths), "journal progress transition is invalid");
		}
		const previous = states[item.index] ?? "none";
		if (item.kind === "stage") {
			if (
				previous !== "none" ||
				states.some(state => state === "publish-begin" || state === "publish-end") ||
				states.slice(0, item.index).some(state => state !== "stage")
			) {
				throw new MemoryJournalError(lockConflictRelPath(relPaths), "journal stage transition is invalid");
			}
			states[item.index] = "stage";
			continue;
		}
		if (item.kind === "publish-begin") {
			if (previous !== "stage") {
				throw new MemoryJournalError(lockConflictRelPath(relPaths), "journal publish-begin transition is invalid");
			}
			for (let prior = 0; prior < item.index; prior += 1) {
				if (states[prior] !== "publish-end") {
					throw new MemoryJournalError(lockConflictRelPath(relPaths), "journal publish order is invalid");
				}
			}
			states[item.index] = "publish-begin";
			continue;
		}
		if (previous !== "publish-begin") {
			throw new MemoryJournalError(lockConflictRelPath(relPaths), "journal publish-end transition is invalid");
		}
		states[item.index] = "publish-end";
	}
	return Object.freeze({ states: Object.freeze(states), committed });
}

function authorizeRecoveryPublish(environment: MemoryEnvironment, rootPath: string, entry: JournalEntry): void {
	let bytes: Buffer;
	try {
		const admitted = admittedPath(rootPath, entry.tempPath);
		bytes = openVerifiedFile(admitted.root, admitted.contained.relativePath);
	} catch (error) {
		throw memoryJournalError(entry.relPath, "journal recovery temp could not be disclosed", error);
	}
	if (digestBytes(bytes) !== entry.postDigest) {
		throw new MemoryJournalError(entry.relPath, "journal recovery temp does not match postimage");
	}
	const content = bytes.toString("utf8");
	if (!Buffer.from(content, "utf8").equals(bytes)) {
		throw new MemoryJournalError(entry.relPath, "journal recovery temp is not valid UTF-8");
	}
	const destination = writeDestinationForPath(entry.relPath);
	const grant = authorizeAccess({
		environment,
		destination,
		sensitivity: "private",
		relPath: entry.relPath,
		content,
	});
	if (!grant.ok) throw new MemoryJournalError(entry.relPath, "journal recovery authorization failed");
	const publishRoot = pinMemoryRoot(rootPath);
	if (!publishRoot.ok || publishRoot.value.canonicalPath !== grant.value.root.canonicalPath) {
		throw new MemoryJournalError(entry.relPath, "journal recovery authorization root changed");
	}
	const verified = verifyAccessGrant(grant.value, grant.value.target, destination, digestBytes(bytes));
	if (!verified.ok) throw new MemoryJournalError(entry.relPath, "journal recovery authorization changed");
}

export async function recoverJournalAt(
	rootPath: string,
	mutationId: string,
	environment: MemoryEnvironment,
): Promise<JournalRecoveryOutcome> {
	const normalizedMutationId = normalizeMutationId(mutationId);
	let journal: MemoryJournal;
	try {
		journal = await readJournal(rootPath, normalizedMutationId);
	} catch (error) {
		if (error instanceof MemoryJournalError) throw error;
		throw new MemoryJournalError(`${normalizedMutationId}.json`, "journal is not readable");
	}
	let progress: readonly JournalProgress[];
	try {
		progress = await readJournalProgress(rootPath, normalizedMutationId);
	} catch (error) {
		const relPath = lockConflictRelPath(journal.entries.map(entry => entry.relPath));
		if (error instanceof MemoryJournalError) throw new MemoryJournalError(relPath, error.message);
		throw new MemoryJournalError(relPath, "journal progress is not readable");
	}
	const relPaths = journal.entries.map(entry => entry.relPath);
	const durable = parseDurableProgress(progress, journal.entries.length, relPaths);
	// P9: the progress log is unlinked before the journal, so a crash in that
	// window leaves a committed transaction with no durable progress. Every target
	// already matching its postimage is provably complete, so finish the cleanup
	// instead of failing closed on the missing log.
	if (
		progress.length === 0 &&
		journal.entries.every(entry => postMatches(pathState(rootPath, entry.relPath), entry.postDigest))
	) {
		try {
			for (const entry of journal.entries) removeJournalTemp(rootPath, entry);
			await removeJournalFiles(rootPath, normalizedMutationId);
		} catch (error) {
			if (error instanceof MemoryJournalError) throw error;
			throw new MemoryJournalError(lockConflictRelPath(relPaths), "journal cleanup failed");
		}
		return Object.freeze({
			mutationId: normalizedMutationId,
			state: "complete",
			relPaths: Object.freeze(sortedRelPaths(relPaths)),
		});
	}
	const entryStates: RecoveryEntryState[] = journal.entries.map((entry, index) => {
		const target = pathState(rootPath, entry.relPath);
		const temp = pathState(rootPath, entry.tempPath);
		const progressState = durable.states[index] ?? "none";
		const tempInvalid = temp.kind === "other" || (temp.kind === "file" && temp.digest !== entry.postDigest);
		if (tempInvalid)
			return {
				entry,
				progress: progressState,
				target,
				temp,
				state: "fail-closed",
			};
		if (durable.committed) {
			return {
				entry,
				progress: progressState,
				target,
				temp,
				state:
					progressState === "publish-end" && postMatches(target, entry.postDigest) ? "complete" : "fail-closed",
			};
		}
		if (progressState === "publish-end") {
			return {
				entry,
				progress: progressState,
				target,
				temp,
				state: postMatches(target, entry.postDigest) ? "complete" : "fail-closed",
			};
		}
		if (progressState === "publish-begin") {
			if (postMatches(target, entry.postDigest)) {
				return {
					entry,
					progress: progressState,
					target,
					temp,
					state: "complete",
				};
			}
			if (expectedMatches(target, entry.expectedDigest, entry.relPath) && temp.kind === "file") {
				return {
					entry,
					progress: progressState,
					target,
					temp,
					state: "publishable",
				};
			}
			return {
				entry,
				progress: progressState,
				target,
				temp,
				state: "fail-closed",
			};
		}
		// No `publish-begin` was ever recorded for this entry, so nothing was
		// published from it. A target that happens to match the postimage here is
		// pre-existing content, not our work: keep evaluating the preimage instead
		// of failing closed, so the no-progress case stays rollbackable.
		if (entry.expectedDigest !== null && postMatches(target, entry.postDigest)) {
			return {
				entry,
				progress: progressState,
				target,
				temp,
				state: "fail-closed",
			};
		}
		if (!expectedMatches(target, entry.expectedDigest, entry.relPath)) {
			return {
				entry,
				progress: progressState,
				target,
				temp,
				state: "fail-closed",
			};
		}
		if (temp.kind === "file")
			return {
				entry,
				progress: progressState,
				target,
				temp,
				state: "publishable",
			};
		return {
			entry,
			progress: progressState,
			target,
			temp,
			state: "rollbackable",
		};
	});

	const invalid = entryStates.filter(item => item.state === "fail-closed");
	const alreadyPublished = entryStates
		.filter(
			item =>
				item.progress === "publish-end" ||
				(item.progress === "publish-begin" && postMatches(item.target, item.entry.postDigest)),
		)
		.map(item => item.entry.relPath);
	if (invalid.length > 0) {
		throw new MemoryJournalError(
			lockConflictRelPath([...alreadyPublished, ...invalid.map(item => item.entry.relPath)]),
			"journal recovery failed closed",
		);
	}

	const allComplete = entryStates.every(item => item.state === "complete");
	if (durable.committed) {
		try {
			for (const item of entryStates) removeJournalTemp(rootPath, item.entry);
			await removeJournalFiles(rootPath, normalizedMutationId);
		} catch (error) {
			if (error instanceof MemoryJournalError) throw error;
			throw new MemoryJournalError(lockConflictRelPath(relPaths), "journal cleanup failed");
		}
		return Object.freeze({
			mutationId: normalizedMutationId,
			state: "complete",
			relPaths: Object.freeze(sortedRelPaths(relPaths)),
		});
	}

	const hasPublished = entryStates.some(item => item.progress === "publish-begin" || item.progress === "publish-end");
	if (!hasPublished) {
		try {
			for (const item of entryStates) removeJournalTemp(rootPath, item.entry);
			await removeJournalFiles(rootPath, normalizedMutationId);
		} catch (error) {
			if (error instanceof MemoryJournalError) throw error;
			throw new MemoryJournalError(lockConflictRelPath(relPaths), "journal rollback failed");
		}
		return Object.freeze({
			mutationId: normalizedMutationId,
			state: allComplete ? "complete" : "rollbackable",
			relPaths: Object.freeze(sortedRelPaths(relPaths)),
		});
	}

	let published = false;
	const publishedRelPaths: string[] = [];
	for (let index = 0; index < entryStates.length; index += 1) {
		const item = entryStates[index];
		if (item === undefined) continue;
		if (item.state === "complete") {
			try {
				if (item.progress === "publish-begin")
					await appendJournalProgress(rootPath, normalizedMutationId, {
						kind: "publish-end",
						index,
					});
				removeJournalTemp(rootPath, item.entry);
				if (!publishedRelPaths.includes(item.entry.relPath)) publishedRelPaths.push(item.entry.relPath);
			} catch (error) {
				const reason = error instanceof MemoryJournalError ? error.message : "journal recovery cleanup failed";
				throw new MemoryJournalError(lockConflictRelPath([...publishedRelPaths, item.entry.relPath]), reason);
			}
			continue;
		}
		try {
			if (item.progress !== "publish-begin") {
				await appendJournalProgress(rootPath, normalizedMutationId, {
					kind: "publish-begin",
					index,
				});
			}
			authorizeRecoveryPublish(environment, rootPath, item.entry);
			await publishJournalEntry(rootPath, item.entry, undefined, index);
			await appendJournalProgress(rootPath, normalizedMutationId, {
				kind: "publish-end",
				index,
			});
			removeJournalTemp(rootPath, item.entry);
			published = true;
			publishedRelPaths.push(item.entry.relPath);
		} catch (error) {
			const reason = error instanceof MemoryJournalError ? error.message : "journal forward roll failed";
			throw new MemoryJournalError(lockConflictRelPath([...publishedRelPaths, item.entry.relPath]), reason);
		}
	}
	await appendJournalProgress(rootPath, normalizedMutationId, {
		kind: "commit",
	});
	await removeJournalFiles(rootPath, normalizedMutationId);
	return Object.freeze({
		mutationId: normalizedMutationId,
		state: published ? "publishable" : "complete",
		relPaths: Object.freeze(sortedRelPaths(relPaths)),
	});
}

export async function listJournalMutationIds(rootPath: string): Promise<readonly string[]> {
	const root = normalizeRootPath(rootPath, ".journal");
	const directory = path.join(root, ".journal");
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return Object.freeze([]);
		throw new MemoryJournalError(".journal", "journal directory cannot be read");
	}
	const ids = names
		.filter(name => name.endsWith(".json"))
		.map(name => name.slice(0, -5))
		.filter(name => name.length > 0)
		.map(name => normalizeMutationId(name));
	return Object.freeze(sortMemoryLockPaths(ids));
}

function listJournalMutationIdsSync(rootPath: string): readonly string[] {
	const root = normalizeRootPath(rootPath, ".journal");
	const directory = path.join(root, ".journal");
	let names: readonly string[];
	try {
		names = fsSync.readdirSync(directory, { encoding: "utf8" });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return Object.freeze([]);
		throw new MemoryJournalError(".journal", "journal directory cannot be read");
	}
	const ids = names
		.filter(name => name.endsWith(".json"))
		.map(name => name.slice(0, -5))
		.filter(name => name.length > 0)
		.map(name => normalizeMutationId(name));
	return Object.freeze(sortMemoryLockPaths(ids));
}

function journalPathsIntersect(left: readonly string[], right: readonly string[]): boolean {
	if (right.length === 0) return true;
	const requested = new Set(right);
	return left.some(relPath => requested.has(relPath));
}

function inspectPendingJournals(
	environment: MemoryEnvironment,
	relPaths: readonly string[] = [],
): MemoryResult<JournalAdmissionValue> {
	let mutationIds: readonly string[];
	try {
		mutationIds = listJournalMutationIdsSync(environment.memoryRoot);
	} catch (error) {
		return journalAdmissionError(error);
	}
	const affected: string[] = [];
	for (const mutationId of mutationIds) {
		try {
			const inspection = inspectJournalSync(environment.memoryRoot, mutationId);
			if (!inspection.complete && journalPathsIntersect(inspection.relPaths, relPaths))
				affected.push(...inspection.relPaths);
		} catch (error) {
			if (error instanceof MemoryJournalError) affected.push(error.relPath);
			else affected.push(".journal");
		}
	}
	if (affected.length > 0) return journalAdmissionLockConflict(lockConflictRelPath(affected));
	return { ok: true, value: Object.freeze([]) };
}

async function recoverPendingJournals(
	environment: MemoryEnvironment,
	relPaths: readonly string[] = [],
): Promise<MemoryResult<JournalAdmissionValue>> {
	let mutationIds: readonly string[];
	try {
		mutationIds = await listJournalMutationIds(environment.memoryRoot);
	} catch (error) {
		return journalAdmissionError(error);
	}
	const outcomes: JournalRecoveryOutcome[] = [];
	for (const mutationId of mutationIds) {
		let journalRelPaths: readonly string[] = [];
		try {
			const journal = await readJournal(environment.memoryRoot, mutationId);
			journalRelPaths = journal.entries.map(entry => entry.relPath);
			if (!journalPathsIntersect(journalRelPaths, relPaths)) continue;
		} catch {
			if (relPaths.length > 0) return journalAdmissionLockConflict(".journal");
		}
		try {
			const outcome = await withMemoryWriteLocks(environment.memoryRoot, journalRelPaths, () =>
				recoverJournalAt(environment.memoryRoot, mutationId, environment),
			);
			outcomes.push(outcome);
		} catch (error) {
			return journalAdmissionError(
				error,
				journalRelPaths.length > 0 ? lockConflictRelPath(journalRelPaths) : ".journal",
			);
		}
	}
	return { ok: true, value: Object.freeze(outcomes) };
}

export function admitPendingJournals(environment: MemoryEnvironment): Promise<MemoryResult<JournalAdmissionValue>>;
export function admitPendingJournals(
	environment: MemoryEnvironment,
	mode: "write",
	relPaths?: readonly string[],
): Promise<MemoryResult<JournalAdmissionValue>>;
export function admitPendingJournals(
	environment: MemoryEnvironment,
	mode: "read" | "doctor",
	relPaths?: readonly string[],
): MemoryResult<JournalAdmissionValue>;
export function admitPendingJournals(
	environment: MemoryEnvironment,
	mode: JournalAdmissionMode = "write",
	relPaths: readonly string[] = [],
): MemoryResult<JournalAdmissionValue> | Promise<MemoryResult<JournalAdmissionValue>> {
	const validated = validateMemoryEnvironment(environment);
	if (!validated.ok) return mode === "write" ? Promise.resolve(validated) : validated;
	if (mode === "write") return recoverPendingJournals(validated.value, relPaths);
	if (mode === "doctor") return { ok: true, value: Object.freeze([]) };
	return inspectPendingJournals(validated.value, relPaths);
}

export function journalRelPathSet(paths: readonly string[]): string {
	return lockConflictRelPath(paths);
}

export function readContainedBytes(rootPath: string, relPath: string): Buffer | null {
	const state = pathState(rootPath, relPath);
	if (state.kind === "absent") return null;
	if (state.kind !== "file")
		throw new MemoryJournalError(relPath, "journal read target is not a trusted regular file");
	const admitted = admittedPath(rootPath, relPath);
	try {
		return openVerifiedFile(admitted.root, admitted.contained.relativePath);
	} catch (error) {
		throw memoryJournalError(relPath, "journal read failed", error);
	}
}

export async function removeJournalProgress(rootPath: string, mutationId: string): Promise<void> {
	const normalizedMutationId = normalizeMutationId(mutationId);
	const root = normalizeRootPath(rootPath, normalizedMutationId);
	unlinkContainedPath(root, journalArtifactRelPath(normalizedMutationId, "progress"));
	await Promise.resolve();
}

export async function removeJournalPlan(rootPath: string, mutationId: string): Promise<void> {
	const normalizedMutationId = normalizeMutationId(mutationId);
	const root = normalizeRootPath(rootPath, normalizedMutationId);
	unlinkContainedPath(root, journalArtifactRelPath(normalizedMutationId, "json"));
	await Promise.resolve();
}
