import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type MemoryDocumentMetadata, parseFrontmatter } from "../documents/frontmatter";
import { parseMarkdownSections } from "../documents/markdown-sections";
import type { MemoryEnvironment, MemoryScopeKind } from "../env";
import { validateMemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import type { RootPin } from "../policy/path-safety";
import { containPath, pinMemoryRoot, validateSafePathComponent, validateSafeRelativePath } from "../policy/path-safety";
import { scanSecretContent } from "../policy/secret-scan";
import { type JournalEntry, type JournalProgress, journalRelPathSet } from "../storage/journal";
import { openVerifiedDir, openVerifiedFile, VerifiedStorageError } from "../storage/verified-open";

import { listReadableDirectory } from "./list-readable-directory";

export interface AuditAdmissionScopeInput {
	readonly kind: MemoryScopeKind;
	readonly root: string;
	readonly maxBytes?: number;
}

export type AuditAdmissionMetadata = Pick<
	MemoryDocumentMetadata,
	| "id"
	| "type"
	| "scope"
	| "authority"
	| "volatility"
	| "sensitivity"
	| "status"
	| "updated"
	| "aliases"
	| "supersedes"
>;

export interface AuditAdmissionEntry {
	/** POSIX path relative to the admitted scope root. */
	readonly relPath: string;
	readonly kind: "file" | "directory" | "symlink";
	/** Permission bits derived from the verified bigint stat. */
	readonly mode: bigint;
	readonly size: bigint;
	readonly binary: boolean;
	/** Line numbers only; document bodies and redacted excerpts never leave admission. */
	readonly secretLines: readonly number[];
	readonly privateMemory: boolean;
	readonly metadata?: AuditAdmissionMetadata;
	readonly digest?: string;
	readonly headings: readonly string[];
	readonly parseError: boolean;
	/** False when the verified stat size exceeded the admission bound. */
}

export interface AuditJournalRecord {
	readonly relPath: string;
	readonly state: "pending" | "recoverable" | "tampered";
}

interface FileVerdict {
	readonly privateMemory: boolean;
	readonly binary: boolean;
	readonly secretLines: readonly number[];
	readonly metadata: AuditAdmissionMetadata | null;
	readonly digest: string | null;
	readonly headings: readonly string[];
	readonly parseError: boolean;
}

interface JournalPair {
	readonly json: string | null;
	readonly progress: string | null;
}

interface ParsedJournal {
	readonly mutationId: string;
	readonly entries: readonly JournalEntry[];
}

interface JournalPathState {
	readonly kind: "absent" | "file" | "other";
	readonly digest?: string;
	readonly canonicalDigest?: string;
}

type DurableEntryProgress = "none" | "stage" | "publish-begin" | "publish-end";

interface DurableProgress {
	readonly states: readonly DurableEntryProgress[];
	readonly committed: boolean;
}

const PERMISSION_MASK = 0o7777n;
const DEFAULT_MAX_BYTES = 1_048_576;
const JOURNAL_DIRECTORY = ".journal";
const JOURNAL_SCHEMA_VERSION = "gajae.memory.journal.v1";

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "global-canonical",
			reason,
		},
	};
}

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameIdentity(
	left: { readonly dev: bigint; readonly ino: bigint },
	right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function normalizeScopeRelativeRoot(
	environment: MemoryEnvironment,
	rootPin: RootPin,
	configuredRoot: string,
): MemoryResult<string> {
	if (typeof configuredRoot !== "string" || !path.isAbsolute(configuredRoot) || configuredRoot.includes("\u0000")) {
		return invalidInput("audit scope root must be an absolute path");
	}
	const absolute = path.resolve(configuredRoot);
	for (const base of [rootPin.canonicalPath, path.resolve(environment.memoryRoot)]) {
		const relative = path.relative(base, absolute).split(path.sep).join("/");
		if (path.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) continue;
		return { ok: true, value: relative };
	}
	return policyDenied("audit scope root escaped the memory root");
}

function expectedScopeRoot(kind: MemoryScopeKind, relative: string): boolean {
	const pieces = relative.length === 0 ? [] : relative.split("/");
	if (kind === "global") return pieces.length === 1 && pieces[0] === "global";
	if (kind === "project") return pieces.length === 2 && pieces[0] === "projects";
	return pieces.length === 2 && pieces[0] === "sessions";
}

function pathJoin(left: string, right: string): string {
	return (left.length === 0 ? right : `${left}/${right}`).normalize("NFC");
}

function emptyFileVerdict(): FileVerdict {
	return Object.freeze({
		binary: false,
		privateMemory: false,
		secretLines: Object.freeze([]),
		metadata: null,
		digest: null,
		headings: Object.freeze([]),
		parseError: false,
	});
}

function binaryAndSecrets(bytes: Buffer, relPath: string): MemoryResult<FileVerdict> {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return {
			ok: true,
			value: Object.freeze({
				...emptyFileVerdict(),
				binary: true,
			}),
		};
	}
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (code === 0 || (code < 0x09 && code !== 0x00) || (code >= 0x0e && code < 0x20)) {
			return {
				ok: true,
				value: Object.freeze({
					...emptyFileVerdict(),
					binary: true,
				}),
			};
		}
	}
	if (text.includes("\ufffd")) {
		return {
			ok: true,
			value: Object.freeze({
				...emptyFileVerdict(),
				binary: true,
			}),
		};
	}
	const normalized = text.replace(/\r\n?/gu, "\n").normalize("NFC");
	const digest = createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex");
	const parsed = parseFrontmatter(text, relPath);
	let metadata: AuditAdmissionMetadata | null = null;
	let headings: readonly string[] = Object.freeze([]);
	let parseError = false;
	if (parsed.ok) {
		metadata = Object.freeze({
			id: parsed.value.metadata.id,
			type: parsed.value.metadata.type,
			scope: parsed.value.metadata.scope,
			authority: parsed.value.metadata.authority,
			volatility: parsed.value.metadata.volatility,
			sensitivity: parsed.value.metadata.sensitivity,
			status: parsed.value.metadata.status,
			updated: parsed.value.metadata.updated,
			aliases: Object.freeze([...parsed.value.metadata.aliases]),
			supersedes: Object.freeze([...parsed.value.metadata.supersedes]),
		});
		const sections = parseMarkdownSections(parsed.value.body, parsed.value.bodyStartLine - 1);
		if (sections.ok) headings = Object.freeze(sections.value.map(section => section.heading));
		else parseError = true;
	} else {
		parseError = true;
	}
	const privateMemory = metadata?.sensitivity === "private" || metadata?.sensitivity === "restricted";
	const scanned = scanSecretContent(text);
	if (!scanned.ok) return policyDenied("audit secret scan failed closed");
	const secretLines = scanned.value.findings.map(item => item.line);
	return {
		ok: true,
		value: Object.freeze({
			binary: false,
			privateMemory,
			secretLines: Object.freeze(secretLines),
			metadata,
			digest,
			headings,
			parseError,
		}),
	};
}

function admittedEntry(
	rootPin: RootPin,
	relPath: string,
	kind: "file" | "directory" | "symlink",
	maxBytes: number,
): MemoryResult<AuditAdmissionEntry> {
	const contained = containPath(rootPin, relPath);
	if (!contained.ok) return contained;
	const identity = contained.value.leafIdentity;
	if (identity === null) return policyDenied("audit entry disappeared during admission");
	const admittedRelPath = contained.value.relativePath;
	const mode = identity.mode & PERMISSION_MASK;
	if (kind === "directory") {
		return {
			ok: true,
			value: Object.freeze({
				relPath: admittedRelPath,
				kind,
				mode,
				size: identity.size,
				binary: false,
				secretLines: Object.freeze([]),
				privateMemory: false,
				headings: Object.freeze([]),
				parseError: false,
			}),
		};
	}
	if (kind !== "file") {
		return {
			ok: true,
			value: Object.freeze({
				relPath: admittedRelPath,
				kind,
				mode,
				size: identity.size,
				binary: false,
				secretLines: Object.freeze([]),
				privateMemory: false,
				headings: Object.freeze([]),
				parseError: false,
			}),
		};
	}
	if (identity.size > BigInt(maxBytes)) {
		return {
			ok: true,
			value: Object.freeze({
				relPath: admittedRelPath,
				kind,
				mode,
				size: identity.size,
				binary: false,
				secretLines: Object.freeze([]),
				privateMemory: false,
				headings: Object.freeze([]),
				parseError: false,
			}),
		};
	}
	let bytes: Buffer;
	try {
		bytes = openVerifiedFile(rootPin, admittedRelPath);
	} catch (error) {
		if (error instanceof VerifiedStorageError) return policyDenied("audit entry could not be safely read");
		return policyDenied(`audit entry read failed: ${errorCode(error) ?? "read-failed"}`);
	}
	const verdict = binaryAndSecrets(bytes, admittedRelPath);
	if (!verdict.ok) return verdict;
	return {
		ok: true,
		value: Object.freeze({
			relPath: admittedRelPath,
			kind,
			mode,
			size: identity.size,
			binary: verdict.value.binary,
			secretLines: verdict.value.secretLines,
			privateMemory: verdict.value.privateMemory,
			metadata: verdict.value.metadata ?? undefined,
			digest: verdict.value.digest ?? undefined,
			headings: verdict.value.headings,
			parseError: verdict.value.parseError,
		}),
	};
}

/**
 * Admit a scope for read-only doctor inspection. The returned paths are
 * relative to that scope root and contain metadata/verdicts only; bytes are
 * consumed inside this policy-owned boundary and never returned.
 */
export function admitAuditScope(
	environment: MemoryEnvironment,
	scope: AuditAdmissionScopeInput,
): MemoryResult<readonly AuditAdmissionEntry[]> {
	const validatedEnvironment = validateMemoryEnvironment(environment);
	if (!validatedEnvironment.ok) return validatedEnvironment;
	if (
		scope === null ||
		typeof scope !== "object" ||
		Array.isArray(scope) ||
		(scope.kind !== "global" && scope.kind !== "project" && scope.kind !== "session")
	) {
		return invalidInput("audit scope is invalid");
	}
	const maxBytes = scope.maxBytes === undefined ? DEFAULT_MAX_BYTES : scope.maxBytes;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
		return invalidInput("audit maxBytes must be a positive safe integer");
	const rootPin = pinMemoryRoot(validatedEnvironment.value.memoryRoot);
	if (!rootPin.ok) return rootPin;
	const relativeRoot = normalizeScopeRelativeRoot(validatedEnvironment.value, rootPin.value, scope.root);
	if (!relativeRoot.ok) return relativeRoot;
	if (!expectedScopeRoot(scope.kind, relativeRoot.value)) {
		return policyDenied("audit scope root is not an admitted memory component");
	}
	const rootBinding = containPath(rootPin.value, relativeRoot.value);
	if (!rootBinding.ok) return rootBinding;
	if (rootBinding.value.leafIdentity === null) return { ok: true, value: Object.freeze([]) };
	const rootEntry = admittedEntry(rootPin.value, relativeRoot.value, "directory", maxBytes);
	if (!rootEntry.ok) return rootEntry;
	const entries: AuditAdmissionEntry[] = [Object.freeze({ ...rootEntry.value, relPath: "" })];
	const walk = (scopeRelativePath: string): MemoryResult<true> => {
		const listed = listReadableDirectory(validatedEnvironment.value, scope, scopeRelativePath);
		if (!listed.ok) return policyDenied("audit scope directory could not be safely admitted");
		for (const child of listed.value) {
			const childRelativePath = pathJoin(scopeRelativePath, child.name);
			const memoryRelativePath = pathJoin(relativeRoot.value, childRelativePath);
			// `CandidateDirectoryEntry.kind` is optional; the policy-owned lister
			// always reports it, and an unknown kind must fail closed rather than
			// be silently audited as a regular file.
			if (child.kind === undefined) return policyDenied("audit entry kind could not be determined");
			const admitted = admittedEntry(rootPin.value, memoryRelativePath, child.kind, maxBytes);
			if (!admitted.ok) return policyDenied("audit resource admission failed");
			entries.push(Object.freeze({ ...admitted.value, relPath: childRelativePath }));
			if (child.kind === "directory") {
				const nested = walk(childRelativePath);
				if (!nested.ok) return nested;
			}
		}
		return { ok: true, value: true };
	};
	const walked = walk("");
	if (!walked.ok) return walked;
	return { ok: true, value: Object.freeze(entries) };
}

function validMutationId(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value !== "." &&
		value !== ".." &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("\u0000")
	);
}

function parseJournalPayload(value: unknown, mutationId: string): ParsedJournal | null {
	if (!isRecord(value) || value.schemaVersion !== JOURNAL_SCHEMA_VERSION || value.mutationId !== mutationId)
		return null;
	if (!Array.isArray(value.entries)) return null;
	const entries: JournalEntry[] = [];
	const seen = new Set<string>();
	for (const candidate of value.entries) {
		if (!isRecord(candidate)) return null;
		const validatedPath = validateSafeRelativePath(candidate.relPath);
		const tempPath = candidate.tempPath;
		if (!validatedPath.ok || validatedPath.value.length === 0) return null;
		if (seen.has(validatedPath.value)) return null;
		seen.add(validatedPath.value);
		const expectedDigest = candidate.expectedDigest;
		const postDigest = candidate.postDigest;
		if (expectedDigest !== null && (typeof expectedDigest !== "string" || /[\r\n]/u.test(expectedDigest)))
			return null;
		if (typeof postDigest !== "string" || postDigest.length === 0 || /[\r\n]/u.test(postDigest)) return null;
		if (typeof tempPath !== "string" || tempPath.length === 0 || /[\r\n]/u.test(tempPath)) return null;
		const validatedTempPath = validateSafeRelativePath(tempPath);
		if (
			!validatedTempPath.ok ||
			!validatedTempPath.value.startsWith(`${JOURNAL_DIRECTORY}/`) ||
			validatedTempPath.value === validatedPath.value
		)
			return null;
		entries.push(
			Object.freeze({
				relPath: validatedPath.value,
				expectedDigest: expectedDigest as string | null,
				postDigest,
				tempPath: validatedTempPath.value,
			}),
		);
	}
	return Object.freeze({ mutationId, entries: Object.freeze(entries) });
}

function decodeJournal(bytes: Buffer): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function validProgress(value: string): boolean {
	const normalized = value.replace(/\r\n?/gu, "\n");
	if (!normalized.endsWith("\n")) return false;
	const lines = normalized.slice(0, -1).split("\n");
	let committed = false;
	for (const line of lines) {
		if (line === "commit") {
			if (committed) return false;
			committed = true;
			continue;
		}
		if (!/^(?:stage|publish-begin|publish-end) [0-9]+$/u.test(line) || committed) return false;
	}
	return true;
}

function parseProgress(value: string): readonly JournalProgress[] | null {
	if (!validProgress(value)) return null;
	const normalized = value.replace(/\r\n?/gu, "\n");
	const lines = normalized.slice(0, -1).split("\n");
	const progress: JournalProgress[] = [];
	for (const line of lines) {
		if (line === "commit") {
			progress.push({ kind: "commit" });
			continue;
		}
		const match = /^(stage|publish-begin|publish-end) ([0-9]+)$/u.exec(line);
		if (match === null) return null;
		const rawKind = match[1];
		const index = Number(match[2]);
		if (
			(rawKind !== "stage" && rawKind !== "publish-begin" && rawKind !== "publish-end") ||
			!Number.isSafeInteger(index) ||
			index < 0
		)
			return null;
		progress.push({ kind: rawKind, index });
	}
	return Object.freeze(progress);
}

function parseDurableProgress(progress: readonly JournalProgress[], entryCount: number): DurableProgress | null {
	const states: DurableEntryProgress[] = new Array<DurableEntryProgress>(entryCount).fill("none");
	let committed = false;
	for (const item of progress) {
		if (item.kind === "commit") {
			if (committed || states.some(state => state !== "publish-end")) return null;
			committed = true;
			continue;
		}
		if (committed || item.index >= entryCount) return null;
		const previous = states[item.index] ?? "none";
		if (item.kind === "stage") {
			if (
				previous !== "none" ||
				states.some(state => state === "publish-begin" || state === "publish-end") ||
				states.slice(0, item.index).some(state => state !== "stage")
			)
				return null;
			states[item.index] = "stage";
			continue;
		}
		if (item.kind === "publish-begin") {
			if (previous !== "stage") return null;
			for (let prior = 0; prior < item.index; prior += 1) {
				if (states[prior] !== "publish-end") return null;
			}
			states[item.index] = "publish-begin";
			continue;
		}
		if (previous !== "publish-begin") return null;
		states[item.index] = "publish-end";
	}
	return Object.freeze({ states: Object.freeze(states), committed });
}

function digestBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function canonicalDigestBytes(bytes: Uint8Array): string {
	const raw = Buffer.from(bytes);
	const text = raw.toString("utf8");
	const decoded = Buffer.from(text, "utf8");
	if (!decoded.equals(raw)) return digestBytes(raw);
	return digestBytes(Buffer.from(text.replace(/\r\n?/gu, "\n").normalize("NFC"), "utf8"));
}

function journalPathState(rootPin: RootPin, relPath: string): JournalPathState {
	const contained = containPath(rootPin, relPath);
	if (!contained.ok) return { kind: "other" };
	if (contained.value.leafIdentity === null) return { kind: "absent" };
	let stat: fs.BigIntStats;
	try {
		stat = fs.lstatSync(contained.value.absolutePath, { bigint: true });
	} catch (error) {
		return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "other" };
	}
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1n ||
		stat.dev !== rootPin.dev ||
		!sameIdentity(stat, contained.value.leafIdentity)
	)
		return { kind: "other" };
	try {
		const bytes = openVerifiedFile(rootPin, contained.value.relativePath);
		const after = fs.lstatSync(contained.value.absolutePath, { bigint: true });
		if (
			!after.isFile() ||
			after.isSymbolicLink() ||
			after.nlink !== 1n ||
			after.dev !== stat.dev ||
			after.ino !== stat.ino
		)
			return { kind: "other" };
		return {
			kind: "file",
			digest: digestBytes(bytes),
			canonicalDigest: canonicalDigestBytes(bytes),
		};
	} catch {
		return { kind: "other" };
	}
}

function expectedMatches(state: JournalPathState, expectedDigest: string | null, relPath: string): boolean {
	if (expectedDigest === null) return state.kind === "absent";
	return (
		state.kind === "file" &&
		(relPath.endsWith(".md") && relPath !== "MEMORY.md" ? state.canonicalDigest : state.digest) === expectedDigest
	);
}

function postMatches(state: JournalPathState, postDigest: string): boolean {
	return state.kind === "file" && state.digest === postDigest;
}

function classifyNoProgress(rootPin: RootPin, journal: ParsedJournal): "complete" | "recoverable" | "tampered" {
	const targets = journal.entries.map(entry => journalPathState(rootPin, entry.relPath));
	const temps = journal.entries.map(entry => journalPathState(rootPin, entry.tempPath));
	if (targets.every((state, index) => postMatches(state, journal.entries[index]?.postDigest ?? ""))) {
		for (const [index, entry] of journal.entries.entries()) {
			const temp = temps[index] ?? { kind: "other" as const };
			if (temp.kind === "other" || (temp.kind === "file" && temp.digest !== entry.postDigest)) return "tampered";
		}
		return "complete";
	}
	for (const [index, entry] of journal.entries.entries()) {
		const target = targets[index] ?? { kind: "other" as const };
		const temp = temps[index] ?? { kind: "other" as const };
		if (
			target.kind === "other" ||
			temp.kind === "other" ||
			!expectedMatches(target, entry.expectedDigest, entry.relPath)
		)
			return "tampered";
		if (temp.kind === "file" && temp.digest !== entry.postDigest) return "tampered";
	}
	return "recoverable";
}

function classifyParsedJournal(
	rootPin: RootPin,
	journal: ParsedJournal,
	progressText: string,
): "complete" | "recoverable" | "tampered" {
	const progress = parseProgress(progressText);
	if (progress === null) return "tampered";
	const durable = parseDurableProgress(progress, journal.entries.length);
	if (durable === null) return "tampered";
	const targets = journal.entries.map(entry => journalPathState(rootPin, entry.relPath));
	const temps = journal.entries.map(entry => journalPathState(rootPin, entry.tempPath));
	if (
		progress.length === 0 &&
		targets.every((state, index) => postMatches(state, journal.entries[index]?.postDigest ?? ""))
	)
		return "complete";
	for (const [index, entry] of journal.entries.entries()) {
		const target = targets[index] ?? { kind: "other" as const };
		const temp = temps[index] ?? { kind: "other" as const };
		const progressState = durable.states[index] ?? "none";
		if (target.kind === "other" || temp.kind === "other") return "tampered";
		if (temp.kind === "file" && temp.digest !== entry.postDigest) return "tampered";
		if (durable.committed || progressState === "publish-end") {
			if (!postMatches(target, entry.postDigest)) return "tampered";
			continue;
		}
		if (progressState === "publish-begin") {
			if (postMatches(target, entry.postDigest)) continue;
			if (!expectedMatches(target, entry.expectedDigest, entry.relPath) || temp.kind !== "file") return "tampered";
			continue;
		}
		if (entry.expectedDigest !== null && postMatches(target, entry.postDigest)) return "tampered";
		if (!expectedMatches(target, entry.expectedDigest, entry.relPath)) return "tampered";
	}
	if (
		durable.committed ||
		targets.every((state, index) => postMatches(state, journal.entries[index]?.postDigest ?? ""))
	)
		return "complete";
	return "recoverable";
}

function journalPathSet(journal: ParsedJournal): string {
	return journalRelPathSet(journal.entries.map(entry => entry.relPath));
}

function journalPairPath(pair: JournalPair): string {
	return pair.json ?? pair.progress ?? JOURNAL_DIRECTORY;
}

/** Enumerate the root journal read-only; no recovery or mutation is attempted. */
export function enumerateAuditJournals(environment: MemoryEnvironment): MemoryResult<readonly AuditJournalRecord[]> {
	const validatedEnvironment = validateMemoryEnvironment(environment);
	if (!validatedEnvironment.ok) return validatedEnvironment;
	const rootPin = pinMemoryRoot(validatedEnvironment.value.memoryRoot);
	if (!rootPin.ok) return rootPin;
	const contained = containPath(rootPin.value, JOURNAL_DIRECTORY);
	if (!contained.ok) return contained;
	if (contained.value.leafIdentity === null) return { ok: true, value: Object.freeze([]) };
	let fd: number | undefined;
	try {
		fd = openVerifiedDir(rootPin.value, JOURNAL_DIRECTORY);
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!sameIdentity(opened, contained.value.leafIdentity)) return policyDenied("journal directory binding changed");
		const dirents = fs.readdirSync(contained.value.absolutePath, { withFileTypes: true });
		const pairs = new Map<string, JournalPair>();
		const malformed: string[] = [];
		for (const dirent of dirents) {
			const safeName = validateSafePathComponent(dirent.name);
			if (!safeName.ok || safeName.value !== dirent.name) {
				malformed.push(JOURNAL_DIRECTORY);
				continue;
			}
			const suffix = dirent.name.endsWith(".json")
				? ".json"
				: dirent.name.endsWith(".progress")
					? ".progress"
					: null;
			if (suffix === null) continue;
			const mutationId = dirent.name.slice(0, -suffix.length);
			const relativePath = `${JOURNAL_DIRECTORY}/${dirent.name}`;
			if (!validMutationId(mutationId) || dirent.isSymbolicLink() || !dirent.isFile()) {
				malformed.push(relativePath);
				continue;
			}
			const previous = pairs.get(mutationId) ?? { json: null, progress: null };
			pairs.set(
				mutationId,
				Object.freeze({
					json: suffix === ".json" ? relativePath : previous.json,
					progress: suffix === ".progress" ? relativePath : previous.progress,
				}),
			);
		}
		const records: AuditJournalRecord[] = malformed.map(relPath =>
			Object.freeze({ relPath, state: "pending" as const }),
		);
		for (const [mutationId, pair] of pairs) {
			let journal: ParsedJournal | null = null;
			if (pair.json !== null) {
				try {
					const journalBytes = openVerifiedFile(rootPin.value, pair.json);
					const journalText = decodeJournal(journalBytes);
					if (journalText !== null) {
						try {
							journal = parseJournalPayload(JSON.parse(journalText) as unknown, mutationId);
						} catch {
							journal = null;
						}
					}
				} catch {
					journal = null;
				}
			}
			if (journal === null) {
				records.push(Object.freeze({ relPath: journalPairPath(pair), state: "pending" }));
				continue;
			}
			const relPath = journalPathSet(journal);
			if (pair.progress === null) {
				const state = classifyNoProgress(rootPin.value, journal);
				if (state !== "complete") records.push(Object.freeze({ relPath, state }));
				continue;
			}
			let progressText: string | null = null;
			try {
				progressText = decodeJournal(openVerifiedFile(rootPin.value, pair.progress));
			} catch {
				progressText = null;
			}
			if (progressText === null || !validProgress(progressText)) {
				records.push(Object.freeze({ relPath, state: "pending" }));
				continue;
			}
			const state = classifyParsedJournal(rootPin.value, journal, progressText);
			if (state !== "complete") records.push(Object.freeze({ relPath, state }));
		}
		const after = fs.fstatSync(fd, { bigint: true });
		if (!sameIdentity(opened, after)) return policyDenied("journal directory binding changed after listing");
		records.sort((left, right) => {
			const pathOrder = Buffer.compare(
				Buffer.from(left.relPath.normalize("NFC"), "utf8"),
				Buffer.from(right.relPath.normalize("NFC"), "utf8"),
			);
			if (pathOrder !== 0) return pathOrder;
			return Buffer.compare(Buffer.from(left.state, "utf8"), Buffer.from(right.state, "utf8"));
		});
		return { ok: true, value: Object.freeze(records) };
	} catch (error) {
		if (error instanceof VerifiedStorageError) return policyDenied("journal directory could not be safely admitted");
		return policyDenied(`journal directory read failed: ${errorCode(error) ?? "read-failed"}`);
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Preserve the original read result.
			}
		}
	}
}
