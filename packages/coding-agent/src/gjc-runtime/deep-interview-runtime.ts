import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isSettingsInitialized, Settings } from "../config/settings";
import { listManagedSessionCandidates, resolveManagedSessionScope } from "../sdk/session-directory";
import {
	type FileEntry,
	listProjectSessionTranscriptFiles,
	parseSessionEntries,
	RESUME_TRANSCRIPT_MAX_BYTES,
} from "../session/session-manager";
import { syncSkillActiveState } from "../skill-state/active-state";
import { deriveDeepInterviewHud } from "../skill-state/workflow-hud";
import { WORKFLOW_STATE_VERSION } from "../skill-state/workflow-state-contract";
import {
	type CrystalSnapshot,
	crystallizeDeepInterview,
	crystalMarkdown,
	crystalSnapshotDigest,
	type DeepInterviewCrystal,
} from "./deep-interview-crystallize";
import { isDeepInterviewStageVerb, runDeepInterviewStageCommand } from "./deep-interview-stage";
import {
	assertDeepInterviewInputWithinLimit,
	assertDeepInterviewIntentReview,
	assertDeepInterviewStructuredResponseWithinLimit,
	type DeepInterviewIntentCategory,
	type DeepInterviewIntentItem,
	type DeepInterviewIntentManifest,
	type DeepInterviewIntentReview,
	MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH,
	MAX_INITIAL_CONTEXT_LENGTH,
	normalizeDeepInterviewEnvelope,
	reviewDeepInterviewIntent,
} from "./deep-interview-state";
import { runNativeRalplanCommand } from "./ralplan-runtime";
import { modeStatePath, sessionSpecsDir, transactionJournalPath } from "./session-layout";
import { resolveGjcSessionForWrite, writeSessionActivityMarker } from "./session-resolution";
import { runNativeStateCommand } from "./state-runtime";
import {
	appendJsonl,
	beginWorkflowTransactionJournal,
	completeWorkflowTransactionJournal,
	detectWorkflowEnvelopeIntegrityMismatch,
	readExistingStateForMutation,
	updateWorkflowTransactionJournal,
	type WorkflowTransactionJournal,
	withWorkflowStateLock,
	writeArtifact,
	writeWorkflowEnvelopeAtomic,
} from "./state-writer";
import { assertSafePathComponent, CommandError, flagValue, hasFlag } from "./workflow-cli-common";
import { resolveWorkflowSetting } from "./workflow-settings";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoFutureDeepInterviewEnvelope(value: Record<string, unknown>, surface: string): void {
	if (
		value.version !== undefined &&
		(!Number.isSafeInteger(value.version) || (value.version as number) > WORKFLOW_STATE_VERSION)
	)
		throw new DeepInterviewCommandError(
			2,
			`${surface} has unsupported future deep-interview state version ${String(value.version)}; refusing downgrade`,
		);
}

export * from "./deep-interview-recorder";

/**
 * Native implementation of `gjc deep-interview`.
 *
 * The CLI itself does not run the Socratic interview; that lives inside the `/skill:deep-interview`
 * skill executed by the agent. This handler validates the documented argument-hint surface
 * (`[--trace] [--quick|--standard|--deep] <idea>`), seeds `.gjc/state/deep-interview-state.json`, and
 * updates the shared HUD rail via `syncSkillActiveState` so the active interview is visible to
 * the TUI.
 */

export interface DeepInterviewCommandResult {
	status: number;
	stdout?: string;
	stderr?: string;
}

const DEFAULT_AMBIGUITY_THRESHOLD = 0.05;

const RESOLUTION_THRESHOLDS = {
	quick: 0.6,
	standard: 0.5,
	deep: 0.35,
} as const;

const TRACE_MAX_RELEVANT_PATHS = 12;
const TRACE_MAX_PACKAGE_HINTS = 8;
const TRACE_MAX_DIRECTORY_VISITS = 1200;
const TRACE_MAX_ENTRY_VISITS = 5000;
const TRACE_MAX_PENDING_DIRECTORIES = 1200;
const TRACE_SKIP_DIRS = new Set([
	".git",
	".gjc",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".turbo",
	".cache",
	"vendor",
	"target",
	".venv",
	"venv",
	"__pycache__",
	".pytest_cache",
	"tmp",
	"temp",
	"logs",
	"out",
]);
const TRACE_SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".py",
	".rs",
	".go",
	".java",
	".kt",
	".swift",
	".md",
	".json",
	".yml",
	".yaml",
]);

const DEEP_INTERVIEW_NON_TEXT_CONTENT_TYPES = new Set([
	"image",
	"audio",
	"video",
	"file",
	"content",
	"toolCall",
	"thinking",
]);

interface DeepInterviewTraceSummary {
	enabled: true;
	generated_at: string;
	bounded: true;
	limits: {
		max_relevant_paths: number;
		max_package_hints: number;
		max_directory_visits: number;
		max_entry_visits: number;
		max_pending_directories: number;
	};
	idea_terms: string[];
	project_hints: string[];
	relevant_paths: Array<{ path: string; reason: string }>;
	findings: string[];
}

type DeepInterviewResolution = keyof typeof RESOLUTION_THRESHOLDS;

class DeepInterviewCommandError extends CommandError {
	constructor(exitStatus: number, message: string) {
		super(exitStatus, message);
		this.name = "DeepInterviewCommandError";
	}
}

const VALUE_FLAGS = new Set([
	"--session-id",
	"--threshold",
	"--threshold-source",
	"--stage",
	"--slug",
	"--spec",
	"--handoff",
]);

// Keep the runtime's transcript and publication bounds aligned with the pure
// Crystal validator.  These are byte bounds for recovery reads; normal input
// validation remains code-point bounded by deep-interview-state.ts.
const CRYSTAL_MAX_MESSAGES = 200;
const CRYSTAL_MAX_JOURNAL_BYTES = 64 * 1024;
const CRYSTAL_MAX_INDEX_BYTES = 1_000_000;
const CRYSTAL_MAX_ARTIFACT_BYTES = MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH * 4 + 4096;
const READ_NOFOLLOW_FLAGS =
	fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);

interface CrystalIndexRow {
	slug: string;
	stage: "final";
	path: string;
	created_at: string;
	sha256: string;
	canonicalPath: string;
}

interface CrystalIndexCatalog {
	rows: CrystalIndexRow[];
}

interface CrystalJournalRecord extends WorkflowTransactionJournal {
	artifact_sha256?: unknown;
}

function isErrnoCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isPathWithin(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readBoundedFileBytes(
	filePath: string,
	maxBytes: number,
	label: string,
	options: { allowMissing?: boolean; rejectSymlink?: boolean } = {},
): Promise<Buffer | undefined> {
	let lexicalStat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		lexicalStat = await fs.lstat(filePath);
	} catch (error) {
		if (options.allowMissing && isErrnoCode(error, "ENOENT")) return undefined;
		if (isErrnoCode(error, "ENOENT")) throw new DeepInterviewCommandError(2, `${label} is missing`);
		throw new DeepInterviewCommandError(2, `failed to read ${label}`);
	}
	if (options.rejectSymlink !== false && lexicalStat.isSymbolicLink())
		throw new DeepInterviewCommandError(2, `${label} must not be a symlink`);
	if (!lexicalStat.isFile()) throw new DeepInterviewCommandError(2, `${label} is not a regular file`);
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		handle = await fs.open(filePath, READ_NOFOLLOW_FLAGS);
		const initial = await handle.stat();
		if (!initial.isFile()) throw new DeepInterviewCommandError(2, `${label} is not a regular file`);
		if (initial.size > maxBytes) throw new DeepInterviewCommandError(2, `${label} exceeds the bounded read limit`);
		const output = Buffer.alloc(Number(initial.size));
		let offset = 0;
		while (offset < output.length) {
			const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
			if (bytesRead <= 0) throw new DeepInterviewCommandError(2, `${label} changed during recovery read`);
			offset += bytesRead;
		}
		const final = await handle.stat();
		if (final.size !== initial.size) throw new DeepInterviewCommandError(2, `${label} changed during recovery read`);
		return output;
	} catch (error) {
		if (error instanceof DeepInterviewCommandError) throw error;
		throw new DeepInterviewCommandError(2, `failed to read ${label}`);
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function boundedUtf8(bytes: Buffer, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new DeepInterviewCommandError(2, `${label} is not valid UTF-8`);
	}
}

function crystalSpecsRoot(cwd: string, sessionId: string): string {
	return path.resolve(sessionSpecsDir(cwd, sessionId));
}

function canonicalPublicationPath(cwd: string, sessionId: string, value: string): string {
	const canonical = path.resolve(value);
	if (!isPathWithin(crystalSpecsRoot(cwd, sessionId), canonical))
		throw new DeepInterviewCommandError(2, "Crystal publication path escapes the session specs directory");
	return canonical;
}

async function readCrystalIndexCatalog(
	cwd: string,
	sessionId: string,
	indexPath: string,
): Promise<CrystalIndexCatalog> {
	const bytes = await readBoundedFileBytes(indexPath, CRYSTAL_MAX_INDEX_BYTES, "Crystal index", {
		allowMissing: true,
	});
	if (!bytes) return { rows: [] };
	const text = boundedUtf8(bytes, "Crystal index");
	const rows: CrystalIndexRow[] = [];
	const pathHashes = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new DeepInterviewCommandError(2, "Crystal index contains malformed JSON");
		}
		if (!isRecord(parsed)) throw new DeepInterviewCommandError(2, "Crystal index contains a malformed row");
		const slug = parsed.slug;
		const stage = parsed.stage;
		const rowPath = parsed.path;
		const createdAt = parsed.created_at;
		const sha256 = parsed.sha256;
		if (
			typeof slug !== "string" ||
			slug.trim() === "" ||
			typeof stage !== "string" ||
			stage !== "final" ||
			typeof rowPath !== "string" ||
			typeof createdAt !== "string" ||
			createdAt.trim() === "" ||
			typeof sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(sha256)
		)
			throw new DeepInterviewCommandError(2, "Crystal index contains a malformed row");
		try {
			assertSafePathComponent(slug, "Crystal index slug");
		} catch {
			throw new DeepInterviewCommandError(2, "Crystal index contains an unsafe slug");
		}
		const canonicalPath = canonicalPublicationPath(cwd, sessionId, rowPath);
		const previousHash = pathHashes.get(canonicalPath);
		// Versioned Crystal artifacts are immutable.  A differing hash for one
		// path therefore proves a conflicting ledger row.  Direct spec writes are
		// intentionally mutable and retain their append-only history.
		if (previousHash && previousHash !== sha256 && /-v[0-9]+\.md$/.test(path.basename(canonicalPath)))
			throw new DeepInterviewCommandError(2, "Crystal index contains conflicting rows");
		pathHashes.set(canonicalPath, sha256);
		rows.push({
			slug: slug.trim(),
			stage: "final",
			path: rowPath,
			created_at: createdAt,
			sha256,
			canonicalPath,
		});
	}
	return { rows };
}

function indexRowsForPath(catalog: CrystalIndexCatalog, targetPath: string): CrystalIndexRow[] {
	const canonical = path.resolve(targetPath);
	return catalog.rows.filter(row => row.canonicalPath === canonical);
}

async function verifyPublishedArtifactIndex(options: {
	cwd: string;
	sessionId: string;
	indexPath: string;
	specPath: string;
	specHash: string;
	crystal?: DeepInterviewCrystal;
}): Promise<CrystalIndexCatalog> {
	if (!/^[a-f0-9]{64}$/.test(options.specHash))
		throw new DeepInterviewCommandError(2, "published Crystal hash is invalid");
	const canonicalSpecPath = canonicalPublicationPath(options.cwd, options.sessionId, options.specPath);
	const catalog = await readCrystalIndexCatalog(options.cwd, options.sessionId, options.indexPath);
	const matchingRows = indexRowsForPath(catalog, canonicalSpecPath);
	if (!matchingRows.some(row => row.sha256 === options.specHash))
		throw new DeepInterviewCommandError(2, "published Crystal index verification failed");
	const artifact = await readBoundedFileBytes(
		canonicalSpecPath,
		CRYSTAL_MAX_ARTIFACT_BYTES,
		"published Crystal artifact",
	);
	if (!artifact) throw new DeepInterviewCommandError(2, "published Crystal artifact is missing");
	const actualHash = createHash("sha256").update(artifact).digest("hex");
	if (actualHash !== options.specHash)
		throw new DeepInterviewCommandError(2, "published Crystal artifact verification failed");
	if (options.crystal) {
		const expectedHash = createHash("sha256").update(crystalMarkdown(options.crystal)).digest("hex");
		if (expectedHash !== options.specHash)
			throw new DeepInterviewCommandError(2, "published Crystal artifact does not match stored Crystal");
	}
	return catalog;
}

async function readCrystallizeInput(rawInput: string | undefined, cwd: string): Promise<Record<string, unknown>> {
	if (!rawInput?.trim())
		throw new DeepInterviewCommandError(2, "--input is required for deep-interview --crystallize");
	let raw = rawInput.trim();
	if (raw.startsWith("@")) {
		const filePath = path.resolve(cwd, raw.slice(1));
		try {
			const stat = await fs.stat(filePath);
			if (!stat.isFile() || stat.size > 1_000_000) throw new Error("input file exceeds 1 MiB");
			raw = await fs.readFile(filePath, "utf-8");
		} catch (error) {
			throw new DeepInterviewCommandError(
				2,
				`failed to read --input file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if ([...raw].length > 1_000_000) throw new DeepInterviewCommandError(2, "crystallize input exceeds 1 MiB");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new DeepInterviewCommandError(
			2,
			`--input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	assertDeepInterviewStructuredResponseWithinLimit(parsed);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new DeepInterviewCommandError(2, "crystallize input must be a JSON object");
	return parsed as Record<string, unknown>;
}

function activeSessionEntries(entries: FileEntry[]): FileEntry[] {
	const body = entries.slice(1);
	if (body.length === 0) return body;
	const hasBranchMetadata = body.some(entry => "id" in entry || "parentId" in entry);
	if (!hasBranchMetadata) return body;
	const byId = new Map<string, FileEntry>();
	for (const entry of body) {
		const id = (entry as { id?: unknown }).id;
		const parentId = (entry as { parentId?: unknown }).parentId;
		if (
			typeof id !== "string" ||
			id.trim() === "" ||
			!("parentId" in entry) ||
			(parentId !== null && typeof parentId !== "string")
		)
			throw new DeepInterviewCommandError(2, "live session transcript branch metadata is malformed");
		if (byId.has(id)) throw new DeepInterviewCommandError(2, "live session transcript branch contains duplicate IDs");
		byId.set(id, entry);
	}
	for (const entry of body) {
		const parentId = (entry as { parentId: string | null }).parentId;
		if (parentId !== null && !byId.has(parentId))
			throw new DeepInterviewCommandError(2, "live session transcript branch has a missing parent");
	}
	const branch: typeof body = [];
	const visited = new Set<string>();
	let current = body.at(-1);
	while (current) {
		const id = (current as { id: string }).id;
		if (visited.has(id)) throw new DeepInterviewCommandError(2, "live session transcript branch contains a cycle");
		visited.add(id);
		branch.push(current);
		const parentId = (current as { parentId: string | null }).parentId;
		if (parentId === null) break;
		current = byId.get(parentId);
		if (!current) throw new DeepInterviewCommandError(2, "live session transcript branch has a missing parent");
	}
	branch.reverse();
	return branch;
}

function validateTranscriptRecords(records: unknown[]): void {
	if (records.length === 0 || !isRecord(records[0]) || records[0].type !== "session")
		throw new DeepInterviewCommandError(2, "live session transcript must begin with one session header");
	const headers = records.filter(record => isRecord(record) && record.type === "session");
	if (headers.length !== 1)
		throw new DeepInterviewCommandError(2, "live session transcript has multiple session headers");
	const header = records[0] as Record<string, unknown>;
	if (typeof header.id !== "string" || header.id.trim() === "" || typeof header.cwd !== "string")
		throw new DeepInterviewCommandError(2, "live session transcript header is malformed");
	const version = header.version === undefined ? 1 : header.version;
	if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
		throw new DeepInterviewCommandError(2, "live session transcript header is malformed");
	const body = records.slice(1).filter((record): record is Record<string, unknown> => isRecord(record));
	if (body.length !== records.length - 1)
		throw new DeepInterviewCommandError(2, "live session transcript contains a malformed entry");
	const entries = body.filter(record => record.type !== "header_patch" && record.type !== "entry_patch");
	const hasBranchMetadata = entries.some(entry => "id" in entry || "parentId" in entry);
	if (version >= 2 || hasBranchMetadata) {
		const ids = new Set<string>();
		for (const entry of entries) {
			const id = entry.id;
			const parentId = entry.parentId;
			if (
				typeof entry.type !== "string" ||
				typeof id !== "string" ||
				id.trim() === "" ||
				!("parentId" in entry) ||
				(parentId !== null && typeof parentId !== "string")
			)
				throw new DeepInterviewCommandError(2, "live session transcript branch metadata is malformed");
			if (ids.has(id))
				throw new DeepInterviewCommandError(2, "live session transcript branch contains duplicate IDs");
			ids.add(id);
		}
		for (const entry of entries) {
			const parentId = entry.parentId;
			if (parentId !== null && !ids.has(parentId as string))
				throw new DeepInterviewCommandError(2, "live session transcript branch has a missing parent");
		}
	}
	for (const record of body) {
		if (record.type === "header_patch") {
			if (!isRecord(record.patch) || !Object.keys(record).every(key => key === "type" || key === "patch"))
				throw new DeepInterviewCommandError(2, "live session transcript contains malformed branch metadata");
		}
		if (record.type === "entry_patch") {
			if (
				typeof record.entryId !== "string" ||
				!isRecord(record.patch) ||
				!Object.keys(record).every(key => key === "type" || key === "entryId" || key === "patch")
			)
				throw new DeepInterviewCommandError(2, "live session transcript contains malformed branch metadata");
		}
	}
}

async function authoritativeConversationSnapshot(
	cwd: string,
	sessionId: string,
): Promise<{
	revision: number;
	messages: Array<{ index: number; role: string; content: string }>;
}> {
	const canonicalCandidates = new Set<string>();
	const lexicalCandidates = new Set(listProjectSessionTranscriptFiles(cwd).map(candidate => path.resolve(candidate)));
	const managedScope = await resolveManagedSessionScope({ cwd });
	if (managedScope.kind === "error")
		throw new DeepInterviewCommandError(2, "managed session transcript scope is unavailable");
	if (managedScope.kind === "resolved") {
		const managedListing = await listManagedSessionCandidates({ scope: managedScope.scope });
		if (managedListing.kind === "error")
			throw new DeepInterviewCommandError(2, "managed session transcript listing is unavailable");
		for (const candidate of managedListing.owned) lexicalCandidates.add(path.resolve(candidate.path));
	}
	if (lexicalCandidates.size > 1000)
		throw new DeepInterviewCommandError(2, "session transcript discovery exceeded the bounded candidate limit");
	for (const candidate of [...lexicalCandidates].sort()) {
		try {
			const stat = await fs.lstat(candidate);
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			const realPath = await fs.realpath(candidate);
			if (realPath !== candidate) continue;
			canonicalCandidates.add(realPath);
		} catch {}
	}
	let sessionFile = process.env.GJC_SESSION_FILE?.trim();
	// The native command accepts an explicit workspace cwd, which may differ from
	// process.cwd(). Resolve relative managed transcript paths against that same
	// workspace so transcript identity and content cannot drift with process launch location.
	if (sessionFile) {
		sessionFile = path.resolve(cwd, sessionFile);
		let explicitRealPath: string;
		try {
			const explicitStat = await fs.lstat(sessionFile);
			if (!explicitStat.isFile() || explicitStat.isSymbolicLink())
				throw new Error("symlink or non-regular transcript");
			explicitRealPath = await fs.realpath(sessionFile);
			if (explicitRealPath !== sessionFile) throw new Error("symlink transcript");
		} catch {
			throw new DeepInterviewCommandError(2, "GJC_SESSION_FILE is not a managed canonical session transcript");
		}
		if (!canonicalCandidates.has(explicitRealPath))
			throw new DeepInterviewCommandError(2, "GJC_SESSION_FILE is not a managed canonical session transcript");
		sessionFile = explicitRealPath;
	} else {
		for (const candidate of [...canonicalCandidates].sort()) {
			try {
				const bytes = await readBoundedFileBytes(candidate, RESUME_TRANSCRIPT_MAX_BYTES, "session transcript", {
					allowMissing: true,
				});
				if (!bytes) continue;
				const header = JSON.parse(boundedUtf8(bytes, "session transcript").split(/\r?\n/, 1)[0]) as Record<
					string,
					unknown
				>;
				if (
					header.id === sessionId &&
					typeof header.cwd === "string" &&
					path.resolve(header.cwd) === path.resolve(cwd)
				) {
					sessionFile = candidate;
					break;
				}
			} catch {}
		}
	}
	if (!sessionFile)
		throw new DeepInterviewCommandError(2, "an authenticated session transcript is required for crystallization");
	try {
		const bytes = await readBoundedFileBytes(sessionFile, RESUME_TRANSCRIPT_MAX_BYTES, "live session transcript");
		if (!bytes) throw new DeepInterviewCommandError(2, "live session transcript is unavailable");
		const text = boundedUtf8(bytes, "live session transcript");
		const records: unknown[] = [];
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new DeepInterviewCommandError(2, "live session transcript is malformed");
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new DeepInterviewCommandError(2, "live session transcript is malformed");
			records.push(parsed);
		}
		validateTranscriptRecords(records);
		const entries = parseSessionEntries(text);
		const header = entries[0];
		if (
			header?.type !== "session" ||
			header?.id !== sessionId ||
			typeof header?.cwd !== "string" ||
			path.resolve(header.cwd) !== path.resolve(cwd)
		)
			throw new DeepInterviewCommandError(2, "live session transcript identity mismatch");
		const messages: Array<{ index: number; role: string; content: string }> = [];
		for (const entry of activeSessionEntries(entries)) {
			if (entry.type !== "message") continue;
			const index = messages.length;
			const message = entry.message as unknown;
			if (!isRecord(message) || typeof message.role !== "string")
				throw new DeepInterviewCommandError(2, "live session transcript contains a malformed message");
			let projectedContent: string;
			if (typeof message.content === "string") {
				projectedContent = message.content;
			} else if (Array.isArray(message.content)) {
				const projectedParts: string[] = [];
				for (const item of message.content) {
					if (!isRecord(item) || typeof item.type !== "string")
						throw new DeepInterviewCommandError(
							2,
							"live session transcript contains unsupported message content",
						);
					if (item.type === "text") {
						if (typeof item.text !== "string")
							throw new DeepInterviewCommandError(2, "live session transcript contains malformed text content");
						projectedParts.push(item.text);
					} else if (DEEP_INTERVIEW_NON_TEXT_CONTENT_TYPES.has(item.type)) {
						projectedParts.push(`[${item.type}]`);
					} else {
						throw new DeepInterviewCommandError(
							2,
							"live session transcript contains unsupported message content",
						);
					}
				}
				projectedContent = projectedParts.join("");
			} else {
				throw new DeepInterviewCommandError(2, "live session transcript contains malformed message content");
			}
			messages.push({ index, role: message.role, content: projectedContent.normalize("NFC").trim() });
		}
		if (messages.length === 0) throw new DeepInterviewCommandError(2, "live session transcript has no messages");
		return { revision: messages.length, messages };
	} catch (error) {
		if (error instanceof DeepInterviewCommandError) throw error;
		throw new DeepInterviewCommandError(2, "live session transcript is unavailable");
	}
}

function parseCrystalMutationId(mutationId: string, sessionId: string): { specVersion: number } {
	const prefix = `crystal:${sessionId}:`;
	if (!mutationId.startsWith(prefix))
		throw new DeepInterviewCommandError(2, "Crystal transaction journal identity mismatch");
	const suffix = mutationId.slice(prefix.length);
	const separator = suffix.indexOf(":");
	if (
		separator <= 0 ||
		!/^\d+$/.test(suffix.slice(0, separator)) ||
		!/^[a-f0-9]{64}$/.test(suffix.slice(separator + 1))
	)
		throw new DeepInterviewCommandError(2, "pending Crystal transaction journal is invalid");
	const specVersion = Number(suffix.slice(0, separator));
	if (!Number.isSafeInteger(specVersion) || specVersion < 1)
		throw new DeepInterviewCommandError(2, "pending Crystal transaction journal is invalid");
	return { specVersion };
}

function validateCrystalJournalRecord(
	value: unknown,
	cwd: string,
	sessionId: string,
	indexPath: string,
	statePath: string,
): CrystalJournalRecord {
	if (!isRecord(value)) throw new DeepInterviewCommandError(2, "pending Crystal transaction journal is invalid");
	if (value.version !== 1 || typeof value.mutation_id !== "string")
		throw new DeepInterviewCommandError(2, "pending Crystal transaction journal is invalid");
	parseCrystalMutationId(value.mutation_id, sessionId);
	if (value.status !== "pending" && value.status !== "committed")
		throw new DeepInterviewCommandError(2, "pending Crystal transaction journal is invalid");
	if (
		typeof value.created_at !== "string" ||
		typeof value.updated_at !== "string" ||
		!Array.isArray(value.paths) ||
		value.paths.length !== 3 ||
		!Array.isArray(value.steps) ||
		value.steps.some(step => typeof step !== "string")
	)
		throw new DeepInterviewCommandError(2, "pending Crystal transaction journal is invalid");
	const [specPath, journalIndexPath, journalStatePath] = value.paths;
	if (
		typeof specPath !== "string" ||
		typeof journalIndexPath !== "string" ||
		typeof journalStatePath !== "string" ||
		path.resolve(journalIndexPath) !== path.resolve(indexPath) ||
		path.resolve(journalStatePath) !== path.resolve(statePath)
	)
		throw new DeepInterviewCommandError(2, "pending Crystal transaction journal identity mismatch");
	canonicalPublicationPath(cwd, sessionId, specPath);
	const allowedSteps = new Set(["artifact", "index", "state"]);
	const steps = value.steps as unknown[];
	if (
		new Set(steps).size !== steps.length ||
		steps.some(step => !allowedSteps.has(step as string)) ||
		(steps.includes("index") && !steps.includes("artifact")) ||
		(steps.includes("state") && (!steps.includes("artifact") || !steps.includes("index")))
	)
		throw new DeepInterviewCommandError(2, "pending Crystal transaction journal steps are invalid");
	if (
		value.artifact_sha256 !== undefined &&
		(typeof value.artifact_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifact_sha256))
	)
		throw new DeepInterviewCommandError(2, "pending Crystal transaction journal hash is invalid");
	return value as unknown as CrystalJournalRecord;
}

async function readCrystalJournal(
	cwd: string,
	sessionId: string,
	mutationId: string,
	indexPath: string,
	statePath: string,
): Promise<CrystalJournalRecord | undefined> {
	const journalPath = transactionJournalPath(cwd, sessionId, mutationId);
	const bytes = await readBoundedFileBytes(journalPath, CRYSTAL_MAX_JOURNAL_BYTES, "Crystal transaction journal", {
		allowMissing: true,
	});
	if (!bytes) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(boundedUtf8(bytes, "Crystal transaction journal"));
	} catch {
		throw new DeepInterviewCommandError(2, "pending Crystal transaction journal is corrupt");
	}
	return validateCrystalJournalRecord(parsed, cwd, sessionId, indexPath, statePath);
}

async function verifyPriorPendingCrystalJournals(options: {
	cwd: string;
	sessionId: string;
	indexPath: string;
	statePath: string;
	existing: Record<string, unknown>;
	currentMutationId?: string;
}): Promise<CrystalJournalRecord | undefined> {
	const transactionsDir = path.dirname(transactionJournalPath(options.cwd, options.sessionId, "scan"));
	let names: string[];
	try {
		names = (await fs.readdir(transactionsDir)).filter(name => name.endsWith(".json")).sort();
	} catch (error) {
		if (isErrnoCode(error, "ENOENT")) return undefined;
		throw new DeepInterviewCommandError(2, "Crystal transaction journal discovery failed");
	}
	if (names.length > 128)
		throw new DeepInterviewCommandError(2, "Crystal transaction journal discovery exceeded the bounded limit");
	const catalog = await readCrystalIndexCatalog(options.cwd, options.sessionId, options.indexPath);
	let current: CrystalJournalRecord | undefined;
	for (const name of names) {
		const journalPath = path.join(transactionsDir, name);
		const bytes = await readBoundedFileBytes(journalPath, CRYSTAL_MAX_JOURNAL_BYTES, "Crystal transaction journal");
		if (!bytes) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(boundedUtf8(bytes, "Crystal transaction journal"));
		} catch {
			throw new DeepInterviewCommandError(2, "pending Crystal transaction journal is corrupt");
		}
		if (!isRecord(parsed) || typeof parsed.mutation_id !== "string")
			throw new DeepInterviewCommandError(2, "pending Crystal transaction journal is invalid");
		if (!parsed.mutation_id.startsWith(`crystal:${options.sessionId}:`)) continue;
		const journal = validateCrystalJournalRecord(
			parsed,
			options.cwd,
			options.sessionId,
			options.indexPath,
			options.statePath,
		);
		if (journal.status !== "pending") continue;
		if (journal.mutation_id === options.currentMutationId) {
			current = journal;
			continue;
		}
		const specPath = journal.paths[0]!;
		const canonicalSpecPath = canonicalPublicationPath(options.cwd, options.sessionId, specPath);
		const rows = indexRowsForPath(catalog, canonicalSpecPath);
		let expectedHash = typeof journal.artifact_sha256 === "string" ? journal.artifact_sha256 : undefined;
		for (const row of rows) {
			if (expectedHash && expectedHash !== row.sha256)
				throw new DeepInterviewCommandError(2, "pending Crystal transaction hash mismatch");
			expectedHash = row.sha256;
		}
		const existingSpecPath = typeof options.existing.spec_path === "string" ? options.existing.spec_path : undefined;
		const existingSpecHash =
			typeof options.existing.spec_sha256 === "string" ? options.existing.spec_sha256 : undefined;
		if (existingSpecPath && path.resolve(existingSpecPath) === canonicalSpecPath) {
			if (expectedHash && existingSpecHash && expectedHash !== existingSpecHash)
				throw new DeepInterviewCommandError(2, "pending Crystal transaction hash mismatch");
			expectedHash = existingSpecHash ?? expectedHash;
		}
		if (!expectedHash) throw new DeepInterviewCommandError(2, "pending Crystal transaction cannot be authenticated");
		const artifact = await readBoundedFileBytes(
			canonicalSpecPath,
			CRYSTAL_MAX_ARTIFACT_BYTES,
			"pending Crystal artifact",
		);
		if (!artifact || createHash("sha256").update(artifact).digest("hex") !== expectedHash)
			throw new DeepInterviewCommandError(2, "pending Crystal artifact verification failed");
		if (!rows.some(row => row.sha256 === expectedHash))
			throw new DeepInterviewCommandError(2, "pending Crystal index verification failed");
		if (
			!existingSpecPath ||
			!existingSpecHash ||
			path.resolve(existingSpecPath) !== canonicalSpecPath ||
			existingSpecHash !== expectedHash
		)
			throw new DeepInterviewCommandError(2, "pending Crystal state verification failed");
		await completeWorkflowTransactionJournal(options.cwd, options.sessionId, journal.mutation_id);
	}
	return current;
}

const CRYSTAL_ROLES = new Set(["user", "assistant", "system", "tool", "toolResult", "developer"]);
const CRYSTAL_LIFECYCLES = new Set(["ready", "needs-questions", "stale", "superseded"]);
const CRYSTAL_DELTA_KINDS = new Set(["none", "additive", "intent-changed", "goal-replaced", "stale"]);
const CRYSTAL_ITEM_KINDS = new Set(["goal", "constraint", "decision", "acceptance_criterion", "non_goal"]);
const CRYSTAL_CLASSIFICATIONS = new Set(["confirmed", "inferred", "disputed"]);

function parseCrystalSnapshot(value: unknown, label: string): CrystalSnapshot {
	if (!isRecord(value)) throw new DeepInterviewCommandError(2, `${label} is malformed`);
	const revision = value.revision;
	const start = value.start;
	const end = value.end;
	if (
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		typeof start !== "number" ||
		!Number.isSafeInteger(start) ||
		typeof end !== "number" ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end < start ||
		!Array.isArray(value.messages) ||
		value.messages.length !== end - start + 1 ||
		value.messages.length > CRYSTAL_MAX_MESSAGES
	)
		throw new DeepInterviewCommandError(2, `${label} is malformed`);
	const messages = value.messages.map((entry, index) => {
		if (!isRecord(entry)) throw new DeepInterviewCommandError(2, `${label} contains a malformed message`);
		const messageIndex = entry.index;
		const role = entry.role;
		const content = entry.content;
		if (
			typeof messageIndex !== "number" ||
			!Number.isSafeInteger(messageIndex) ||
			messageIndex !== start + index ||
			typeof role !== "string" ||
			!CRYSTAL_ROLES.has(role) ||
			typeof content !== "string"
		)
			throw new DeepInterviewCommandError(2, `${label} contains a malformed message`);
		return { index: messageIndex, role: role as CrystalSnapshot["messages"][number]["role"], content };
	});
	if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest))
		throw new DeepInterviewCommandError(2, `${label} digest is invalid`);
	const snapshot = { revision, start, end, digest: value.digest, messages } as CrystalSnapshot;
	if (crystalSnapshotDigest(snapshot) !== snapshot.digest)
		throw new DeepInterviewCommandError(2, `${label} digest mismatch`);
	return snapshot;
}

function parseStoredCrystal(value: unknown): DeepInterviewCrystal {
	if (!isRecord(value) || value.schema_version !== 1 || !Number.isSafeInteger(value.spec_version))
		throw new DeepInterviewCommandError(2, "stored Crystal is invalid");
	if (
		(value.spec_version as number) < 1 ||
		typeof value.lifecycle !== "string" ||
		!CRYSTAL_LIFECYCLES.has(value.lifecycle)
	)
		throw new DeepInterviewCommandError(2, "stored Crystal is invalid");
	if (value.execution_approval !== "not-approved")
		throw new DeepInterviewCommandError(2, "stored Crystal execution approval is invalid");
	parseCrystalSnapshot(value.source, "stored Crystal source");
	if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 128)
		throw new DeepInterviewCommandError(2, "stored Crystal items are invalid");
	const ids = new Set<string>();
	for (const item of value.items) {
		if (
			!isRecord(item) ||
			typeof item.id !== "string" ||
			item.id.trim() === "" ||
			ids.has(item.id) ||
			typeof item.kind !== "string" ||
			!CRYSTAL_ITEM_KINDS.has(item.kind) ||
			typeof item.classification !== "string" ||
			!CRYSTAL_CLASSIFICATIONS.has(item.classification) ||
			typeof item.statement !== "string" ||
			item.statement.trim() === ""
		)
			throw new DeepInterviewCommandError(2, "stored Crystal items are invalid");
		if (item.classification === "confirmed") {
			if (
				!isRecord(item.anchor) ||
				!Number.isSafeInteger(item.anchor.message_index) ||
				typeof item.anchor.quote !== "string"
			)
				throw new DeepInterviewCommandError(2, "stored Crystal confirmed item anchor is invalid");
		}
		ids.add(item.id);
	}
	if (!isRecord(value.delta) || typeof value.delta.kind !== "string" || !CRYSTAL_DELTA_KINDS.has(value.delta.kind))
		throw new DeepInterviewCommandError(2, "stored Crystal delta is invalid");
	if (
		!Array.isArray(value.delta.changed_ids) ||
		!Array.isArray(value.delta.added_ids) ||
		!Array.isArray(value.delta.preserved_ids) ||
		typeof value.delta.approval_invalidated !== "boolean" ||
		[...value.delta.changed_ids, ...value.delta.added_ids, ...value.delta.preserved_ids].some(
			id => typeof id !== "string",
		)
	)
		throw new DeepInterviewCommandError(2, "stored Crystal delta is invalid");
	for (const field of ["open_gaps", "conflicts"] as const) {
		if (!Array.isArray(value[field]) || value[field].some(item => typeof item !== "string"))
			throw new DeepInterviewCommandError(2, "stored Crystal resolution fields are invalid");
	}
	for (const field of ["removed_ids", "pending_removals"] as const) {
		if (
			value[field] !== undefined &&
			(!Array.isArray(value[field]) || value[field].some(item => typeof item !== "string"))
		)
			throw new DeepInterviewCommandError(2, "stored Crystal removal fields are invalid");
	}
	return value as unknown as DeepInterviewCrystal;
}

function verifyCrystalSourceAgainstLive(
	crystal: DeepInterviewCrystal,
	liveSnapshot: { revision: number; messages: Array<{ index: number; role: string; content: string }> },
): CrystalSnapshot {
	const source = parseCrystalSnapshot(crystal.source, "stored Crystal source");
	if (source.end >= liveSnapshot.messages.length)
		throw new DeepInterviewCommandError(2, "stored Crystal source is outside the live transcript");
	const expected = liveSnapshot.messages.slice(source.start, source.end + 1);
	if (JSON.stringify(expected) !== JSON.stringify(source.messages))
		throw new DeepInterviewCommandError(2, "stored Crystal source evidence does not match the live transcript");
	return source;
}

async function handleCrystallize(args: readonly string[], cwd: string): Promise<DeepInterviewCommandResult> {
	assertCrystallizeArgs(args);
	const input = await readCrystallizeInput(flagValue(args, "--input"), cwd);
	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		payloadSessionId: input.session_id,
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const sessionId = session.gjcSessionId;
	assertSafePathComponent(sessionId, "session-id");
	const statePath = deepInterviewStatePath(cwd, sessionId);
	return withWorkflowStateLock(
		statePath,
		async () => handleCrystallizeUnlocked(args, cwd, sessionId, statePath, input),
		{ cwd },
	);
}

function assertCrystallizeArgs(args: readonly string[]): void {
	let valueExpected = false;
	for (const arg of args) {
		if (valueExpected) {
			valueExpected = false;
			continue;
		}
		if (arg === "--input" || arg === "--session-id" || arg === "--slug") {
			valueExpected = true;
			continue;
		}
		if (arg === "--crystallize" || arg === "--json") continue;
		throw new DeepInterviewCommandError(2, `unsupported crystallize argument: ${arg}`);
	}
	if (valueExpected) throw new DeepInterviewCommandError(2, "crystallize option requires a value");
	const slug = flagValue(args, "--slug")?.trim();
	if (!slug) throw new DeepInterviewCommandError(2, "--slug is required for deep-interview --crystallize");
}

async function handleCrystallizeUnlocked(
	args: readonly string[],
	cwd: string,
	sessionId: string,
	statePath: string,
	input: Record<string, unknown>,
): Promise<DeepInterviewCommandResult> {
	const existingRead = await readExistingStateForMutation(statePath);
	if (existingRead.kind === "corrupt")
		throw new DeepInterviewCommandError(
			2,
			`existing deep-interview state is corrupt or tampered (${existingRead.error})`,
		);
	if (existingRead.kind === "valid") assertNoFutureDeepInterviewEnvelope(existingRead.value, "crystallize state");
	const existing =
		existingRead.kind === "valid"
			? normalizeDeepInterviewEnvelope(existingRead.value)
			: normalizeDeepInterviewEnvelope({});
	if (existingRead.kind === "valid" && existing.active === false)
		throw new DeepInterviewCommandError(2, "cannot crystallize an inactive deep-interview state");
	const existingInner = isRecord(existing.state) ? existing.state : {};
	const storedPrior = existingInner.crystal;
	const priorCrystal = storedPrior === undefined ? undefined : parseStoredCrystal(storedPrior);
	if (existingRead.kind === "valid" && priorCrystal) {
		try {
			const integrity = await detectWorkflowEnvelopeIntegrityMismatch(statePath);
			if (integrity) throw new DeepInterviewCommandError(2, "stored Crystal state integrity verification failed");
		} catch (error) {
			if (error instanceof DeepInterviewCommandError) throw error;
			throw new DeepInterviewCommandError(2, "stored Crystal state integrity verification failed");
		}
	}
	if (input.prior !== undefined && storedPrior === undefined)
		throw new DeepInterviewCommandError(2, "supplied prior crystal requires canonical stored crystal provenance");
	if (
		input.prior !== undefined &&
		storedPrior !== undefined &&
		JSON.stringify(input.prior) !== JSON.stringify(storedPrior)
	)
		throw new DeepInterviewCommandError(2, "supplied prior crystal does not match canonical stored crystal");
	const liveSnapshot = await authoritativeConversationSnapshot(cwd, sessionId);
	if (liveSnapshot.revision !== input.current_revision)
		throw new DeepInterviewCommandError(2, "conversation snapshot is stale against the live session transcript");
	const snapshot = parseCrystalSnapshot(input.snapshot, "crystallize snapshot");
	if (snapshot.revision !== input.current_revision)
		throw new DeepInterviewCommandError(2, "conversation snapshot is stale");
	if (snapshot.end !== liveSnapshot.messages.length - 1)
		throw new DeepInterviewCommandError(2, "crystallize snapshot must cover the live transcript tail");
	const expectedMessages = liveSnapshot.messages.slice(snapshot.start, snapshot.end + 1);
	if (JSON.stringify(expectedMessages) !== JSON.stringify(snapshot.messages))
		throw new DeepInterviewCommandError(2, "conversation snapshot does not match the live session transcript");
	const existingSpecPath = typeof existing.spec_path === "string" ? existing.spec_path : undefined;
	const existingSpecHash = typeof existing.spec_sha256 === "string" ? existing.spec_sha256 : undefined;
	const indexPath = path.join(sessionSpecsDir(cwd, sessionId), "deep-interview-index.jsonl");
	const priorSource = priorCrystal ? verifyCrystalSourceAgainstLive(priorCrystal, liveSnapshot) : undefined;
	if ((existingSpecPath && !existingSpecHash) || (!existingSpecPath && existingSpecHash))
		throw new DeepInterviewCommandError(2, "existing Crystal publication identity is incomplete");
	if (existingSpecPath && existingSpecHash)
		await verifyPublishedArtifactIndex({
			cwd,
			sessionId,
			indexPath,
			specPath: existingSpecPath,
			specHash: existingSpecHash,
			crystal: priorCrystal?.lifecycle === "ready" ? priorCrystal : undefined,
		});
	if (
		priorCrystal &&
		priorSource &&
		priorSource.revision === snapshot.revision &&
		priorSource.digest === snapshot.digest
	) {
		if (
			priorSource.start !== snapshot.start ||
			priorSource.end !== snapshot.end ||
			JSON.stringify(priorSource.messages) !== JSON.stringify(snapshot.messages)
		)
			throw new DeepInterviewCommandError(2, "stored Crystal source evidence does not match the replay snapshot");
		if (priorCrystal.lifecycle === "ready") {
			if (!existingSpecPath || !existingSpecHash)
				throw new DeepInterviewCommandError(2, "stored Crystal publication identity is incomplete");
			const requestedSlug = flagValue(args, "--slug")!.trim();
			const expectedName = path.basename(existingSpecPath);
			const match = /^deep-interview-(.+)-v[0-9]+\.md$/.exec(expectedName);
			if (!match || match[1] !== requestedSlug)
				throw new DeepInterviewCommandError(2, "conversation snapshot was already crystallized under another slug");
			const mutationId = `crystal:${sessionId}:${priorCrystal.spec_version}:${createHash("sha256")
				.update(`${requestedSlug}\0${path.resolve(existingSpecPath)}`)
				.digest("hex")}`;
			const pending = await verifyPriorPendingCrystalJournals({
				cwd,
				sessionId,
				indexPath,
				statePath,
				existing,
				currentMutationId: mutationId,
			});
			if (pending) {
				if (
					pending.paths.some(
						(value, index) =>
							path.resolve(value) !== path.resolve([existingSpecPath, indexPath, statePath][index]!),
					)
				)
					throw new DeepInterviewCommandError(2, "Crystal promotion journal identity mismatch");
				await completeWorkflowTransactionJournal(cwd, sessionId, mutationId);
			}
			await syncDeepInterviewHud({
				cwd,
				sessionId,
				payload: existing,
				phase: typeof existing.current_phase === "string" ? existing.current_phase : "handoff",
				specStatus: "persisted",
			});
			await writeSessionActivityMarker(cwd, sessionId, { writer: "deep-interview-runtime", path: statePath });
			const summary = {
				skill: "deep-interview",
				mode: "crystallize",
				crystal: priorCrystal,
				spec_path: existingSpecPath,
				state_path: statePath,
			};
			return {
				status: 0,
				stdout: hasFlag(args, "--json")
					? `${JSON.stringify(summary)}\n`
					: `Crystal v${priorCrystal.spec_version} created\nReadiness: ${priorCrystal.lifecycle}\nExecution approval: none\nspec_path=${existingSpecPath}\n`,
			};
		}
		throw new DeepInterviewCommandError(2, "conversation snapshot was already crystallized");
	}
	if (priorSource && snapshot.revision <= priorSource.revision)
		throw new DeepInterviewCommandError(2, "conversation snapshot is stale against the stored Crystal");
	if (!priorCrystal) {
		const canonicalStart = Math.max(0, liveSnapshot.messages.length - CRYSTAL_MAX_MESSAGES);
		if (snapshot.start !== canonicalStart)
			throw new DeepInterviewCommandError(2, "first Crystal must cover the canonical bounded transcript window");
	}
	const payload = { ...input, prior: storedPrior };
	const crystal = crystallizeDeepInterview(payload);
	const slug = flagValue(args, "--slug")!.trim();
	assertSafePathComponent(slug, "slug");
	const specPath =
		crystal.lifecycle === "ready"
			? path.join(sessionSpecsDir(cwd, sessionId), `deep-interview-${slug}-v${crystal.spec_version}.md`)
			: undefined;
	const now = new Date().toISOString();
	const specContent = specPath ? crystalMarkdown(crystal) : undefined;
	if (specContent && [...specContent].length > MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH)
		throw new DeepInterviewCommandError(2, "crystallized specification exceeds the structured response limit");
	const specHash = specContent ? createHash("sha256").update(specContent).digest("hex") : undefined;
	const mutationId =
		specPath && specHash
			? `crystal:${sessionId}:${crystal.spec_version}:${createHash("sha256").update(`${slug}\0${specPath}`).digest("hex")}`
			: undefined;
	const currentJournal = await verifyPriorPendingCrystalJournals({
		cwd,
		sessionId,
		indexPath,
		statePath,
		existing,
		currentMutationId: mutationId,
	});
	const indexCatalog = await readCrystalIndexCatalog(cwd, sessionId, indexPath);
	if (specPath && specContent && mutationId) {
		await beginWorkflowTransactionJournal({
			cwd,
			sessionId,
			mutationId: mutationId!,
			paths: [specPath, indexPath, statePath],
		});
		const journal = currentJournal ?? (await readCrystalJournal(cwd, sessionId, mutationId, indexPath, statePath));
		if (journal && journal.status !== "pending")
			throw new DeepInterviewCommandError(2, "Crystal promotion journal is already committed");
		if (journal && path.resolve(journal.paths[0]!) !== path.resolve(specPath))
			throw new DeepInterviewCommandError(2, "Crystal promotion journal identity mismatch");
		if (journal?.artifact_sha256 !== undefined && journal.artifact_sha256 !== specHash)
			throw new DeepInterviewCommandError(2, "Crystal promotion journal hash mismatch");
		let artifactReady = false;
		const existingArtifact = await readBoundedFileBytes(specPath, CRYSTAL_MAX_ARTIFACT_BYTES, "Crystal artifact", {
			allowMissing: true,
		});
		if (existingArtifact) {
			if (createHash("sha256").update(existingArtifact).digest("hex") !== specHash)
				throw new DeepInterviewCommandError(2, "existing Crystal artifact conflicts with the requested promotion");
			artifactReady = true;
		} else if (journal?.steps.includes("artifact")) {
			throw new DeepInterviewCommandError(2, "pending Crystal artifact verification failed");
		}
		if (!artifactReady)
			await writeArtifact(specPath, specContent, {
				cwd,
				audit: { category: "artifact", verb: "write", owner: "gjc-runtime", skill: "deep-interview", sessionId },
			});
		if (journal || mutationId)
			await updateWorkflowTransactionJournal(cwd, sessionId, mutationId, {
				steps: ["artifact"],
				artifact_sha256: specHash,
			} as Partial<WorkflowTransactionJournal>);
		const indexAlreadyContains = indexRowsForPath(indexCatalog, specPath).some(row => row.sha256 === specHash);
		if (journal?.steps.includes("index") && !indexAlreadyContains)
			throw new DeepInterviewCommandError(2, "pending Crystal index verification failed");
		if (!indexAlreadyContains)
			await appendJsonl(
				indexPath,
				{ slug, stage: "final", path: specPath, created_at: now, sha256: specHash },
				{
					cwd,
					audit: { category: "ledger", verb: "append", owner: "gjc-runtime", skill: "deep-interview", sessionId },
				},
			);
		await updateWorkflowTransactionJournal(cwd, sessionId, mutationId, {
			steps: ["artifact", "index"],
			artifact_sha256: specHash,
		} as Partial<WorkflowTransactionJournal>);
	}
	const state: Record<string, unknown> = { ...existingInner, crystal, execution_approval: "not-approved" };
	delete state.execution_approval_receipt;
	const envelope = {
		...existing,
		active: true,
		current_phase: crystal.lifecycle === "ready" ? "handoff" : "interviewing",
		skill: "deep-interview",
		version: WORKFLOW_STATE_VERSION,
		session_id: sessionId,
		...(specPath && specContent
			? {
					spec_slug: slug,
					spec_path: specPath,
					spec_stage: "final",
					spec_sha256: createHash("sha256").update(specContent).digest("hex"),
					spec_persisted_at: now,
				}
			: {}),
		state,
		updated_at: now,
	};
	if (!specPath) {
		delete envelope.spec_slug;
		delete envelope.spec_path;
		delete envelope.spec_stage;
		delete envelope.spec_sha256;
		delete envelope.spec_persisted_at;
	}
	await writeWorkflowEnvelopeAtomic(statePath, envelope, {
		lockHeld: true,
		cwd,
		receipt: {
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: "gjc deep-interview crystallize",
			sessionId,
			nowIso: now,
		},
		audit: { category: "state", verb: "write", owner: "gjc-runtime", skill: "deep-interview", sessionId },
	});
	if (specPath && specContent && mutationId)
		await updateWorkflowTransactionJournal(cwd, sessionId, mutationId, {
			steps: ["artifact", "index", "state"],
			artifact_sha256: specHash,
		} as Partial<WorkflowTransactionJournal>);
	await writeSessionActivityMarker(cwd, sessionId, { writer: "deep-interview-runtime", path: statePath });
	await syncDeepInterviewHud({
		cwd,
		sessionId,
		payload: envelope,
		phase: envelope.current_phase,
		specStatus: specPath ? "persisted" : "not_persisted",
	});
	if (specPath && specContent && mutationId) await completeWorkflowTransactionJournal(cwd, sessionId, mutationId);
	const summary = {
		skill: "deep-interview",
		mode: "crystallize",
		crystal,
		...(specPath ? { spec_path: specPath } : {}),
		state_path: statePath,
	};
	return {
		status: 0,
		stdout: hasFlag(args, "--json")
			? `${JSON.stringify(summary)}\n`
			: `Crystal v${crystal.spec_version} created\nReadiness: ${crystal.lifecycle}\nExecution approval: none\nspec_path=${specPath}\n`,
	};
}

function defaultSpecSlug(now: Date = new Date()): string {
	const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
	const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
	const dd = now.getUTCDate().toString().padStart(2, "0");
	const hh = now.getUTCHours().toString().padStart(2, "0");
	const min = now.getUTCMinutes().toString().padStart(2, "0");
	return `${yyyy}-${mm}-${dd}-${hh}${min}-${randomBytes(2).toString("hex")}`;
}

export function deepInterviewStatePath(cwd: string, sessionId?: string): string {
	const resolvedSessionId = sessionId?.trim() || process.env.GJC_SESSION_ID?.trim();
	if (!resolvedSessionId) throw new Error("deep-interview state path requires a session id");
	return modeStatePath(cwd, resolvedSessionId, "deep-interview");
}

async function resolveSpecContent(rawSpec: string, cwd: string): Promise<string> {
	const candidate = path.isAbsolute(rawSpec) ? rawSpec : path.resolve(cwd, rawSpec);
	try {
		const stat = await fs.stat(candidate);
		if (stat.isFile()) return await fs.readFile(candidate, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT" && err.code !== "ENOTDIR" && err.code !== "ENAMETOOLONG") {
			throw new DeepInterviewCommandError(2, `failed to read --spec ${candidate}: ${err.message}`);
		}
	}
	return rawSpec;
}

function traceTerms(idea: string): string[] {
	const terms = new Set<string>();
	for (const match of idea.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
		const value = match[0];
		if (["the", "and", "for", "with", "that", "this", "from", "into", "should", "would"].includes(value)) continue;
		terms.add(value);
		if (terms.size >= 12) break;
	}
	return [...terms];
}

function relativePathReason(relativePath: string, terms: readonly string[]): string | undefined {
	const normalized = relativePath.toLowerCase();
	const matched = terms.find(term => normalized.includes(term));
	if (matched) return `path matches idea term "${matched}"`;
	if (/deep[-_]?interview/i.test(relativePath)) return "path matches deep-interview workflow surface";
	if (/skill|workflow|runtime|state/i.test(relativePath)) return "path matches workflow/runtime surface";
	return undefined;
}

async function readPackageHints(cwd: string): Promise<string[]> {
	const packagePath = path.join(cwd, "package.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(packagePath, "utf-8"));
	} catch {
		return [];
	}
	const manifest = parsed as {
		name?: unknown;
		workspaces?: unknown;
		scripts?: Record<string, unknown>;
		dependencies?: Record<string, unknown>;
		devDependencies?: Record<string, unknown>;
	};
	const hints: string[] = [];
	if (typeof manifest.name === "string") hints.push(`package: ${manifest.name}`);
	if (manifest.workspaces) hints.push("workspace: package.json declares workspaces");
	const scripts = Object.keys(manifest.scripts ?? {}).slice(0, TRACE_MAX_PACKAGE_HINTS);
	if (scripts.length > 0) hints.push(`scripts: ${scripts.join(", ")}`);
	const deps = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
		.filter(name => /typescript|bun|react|vite|zod|winston|commander|oclif/i.test(name))
		.slice(0, TRACE_MAX_PACKAGE_HINTS);
	if (deps.length > 0) hints.push(`notable dependencies: ${deps.join(", ")}`);
	return hints.slice(0, TRACE_MAX_PACKAGE_HINTS);
}

async function collectRelevantTracePaths(
	cwd: string,
	terms: readonly string[],
): Promise<Array<{ path: string; reason: string }>> {
	const results: Array<{ path: string; reason: string; score: number }> = [];
	const pending: Array<{ absolutePath: string; depth: number }> = [{ absolutePath: cwd, depth: 0 }];
	let visitedDirectories = 0;
	let visitedEntries = 0;
	while (
		pending.length > 0 &&
		visitedDirectories < TRACE_MAX_DIRECTORY_VISITS &&
		visitedEntries < TRACE_MAX_ENTRY_VISITS
	) {
		const current = pending.shift();
		if (!current) break;
		visitedDirectories += 1;
		try {
			const directory = await fs.opendir(current.absolutePath);
			for await (const entry of directory) {
				visitedEntries += 1;
				if (visitedEntries > TRACE_MAX_ENTRY_VISITS) break;
				if (TRACE_SKIP_DIRS.has(entry.name)) continue;
				const absolutePath = path.join(current.absolutePath, entry.name);
				const relativePath = path.relative(cwd, absolutePath).split(path.sep).join("/");
				if (entry.isDirectory()) {
					if (current.depth < 6 && pending.length < TRACE_MAX_PENDING_DIRECTORIES) {
						pending.push({ absolutePath, depth: current.depth + 1 });
					}
					continue;
				}
				if (!entry.isFile() || !TRACE_SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
				const reason = relativePathReason(relativePath, terms);
				if (!reason) continue;
				const termScore = terms.reduce(
					(score, term) => score + (relativePath.toLowerCase().includes(term) ? 2 : 0),
					0,
				);
				const surfaceScore = /deep[-_]?interview|skill|workflow|runtime|state/i.test(relativePath) ? 1 : 0;
				results.push({ path: relativePath, reason, score: termScore + surfaceScore });
			}
		} catch {}
	}
	return results
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, TRACE_MAX_RELEVANT_PATHS)
		.map(({ path: relativePath, reason }) => ({ path: relativePath, reason }));
}

async function buildDeepInterviewTraceSummary(cwd: string, idea: string): Promise<DeepInterviewTraceSummary> {
	const terms = traceTerms(idea);
	const [projectHints, relevantPaths] = await Promise.all([
		readPackageHints(cwd),
		collectRelevantTracePaths(cwd, terms),
	]);
	const findings = [
		projectHints.length > 0
			? "Project manifest was summarized into bounded package/script/dependency hints."
			: "No readable package.json manifest was found at the project root.",
		relevantPaths.length > 0
			? `Relevant path scan captured ${relevantPaths.length} bounded path hint(s) before interview questions.`
			: "Relevant path scan found no matching source/documentation paths before interview questions.",
		"Trace summary intentionally stores path-level evidence only; raw files and logs are excluded.",
	];
	return {
		enabled: true,
		generated_at: new Date().toISOString(),
		bounded: true,
		limits: {
			max_relevant_paths: TRACE_MAX_RELEVANT_PATHS,
			max_package_hints: TRACE_MAX_PACKAGE_HINTS,
			max_directory_visits: TRACE_MAX_DIRECTORY_VISITS,
			max_entry_visits: TRACE_MAX_ENTRY_VISITS,
			max_pending_directories: TRACE_MAX_PENDING_DIRECTORIES,
		},
		idea_terms: terms,
		project_hints: projectHints,
		relevant_paths: relevantPaths,
		findings,
	};
}

interface ResolvedDeepInterviewArgs {
	resolution: DeepInterviewResolution;
	threshold: number;
	thresholdSource: string;
	sessionId: string;
	idea: string;
	language?: DeepInterviewLanguagePreference;
	trace?: DeepInterviewTraceSummary;
	json: boolean;
}

interface DeepInterviewLanguagePreference {
	code: "en" | "user";
	label: "English" | "User language";
	source: "explicit-user-request" | "initial-idea";
	instruction: string;
}

export interface ResolvedDeepInterviewSpecWriteArgs {
	stage: "final";
	slug: string;
	spec: string;
	sessionId: string;
	json: boolean;
	deliberate: boolean;
	handoff?: "ralplan";
	force: boolean;
}

export interface PersistedDeepInterviewSpec {
	slug: string;
	path: string;
	stage: "final";
	sha256: string;
	createdAt: string;
	statePath: string;
}

interface DeepInterviewSpecWriteSummary {
	skill: "deep-interview";
	stage: "final";
	slug: string;
	path: string;
	sha256: string;
	spec_path: string;
	sha: string;
	created_at: string;
	state_path: string;
	handoff?: {
		to: "ralplan";
		mode: "deliberate";
		state_path?: string;
		run_id?: string;
	};
}

/**
 * Resolve the configured ambiguity threshold through the shared five-layer
 * resolver: project `.gjc/config.yml` > project `.gjc/settings.json` > user
 * `getAgentDir()/config.yml` > legacy config-root `settings.json` > default.
 * Project configuration beats user configuration, and invalid optional files
 * continue to lower layers (tolerant contract). Returns `undefined` when the
 * resolver falls back to the default so the resolution flags (`--quick`/
 * `--standard`/`--deep`) still apply.
 */
async function resolveConfiguredAmbiguityThreshold(
	cwd: string,
	agentDir?: string,
): Promise<{ threshold: number; source: string } | undefined> {
	const resolution = await resolveWorkflowSetting(cwd, "gjc.deepInterview.ambiguityThreshold", {
		defaultValue: DEFAULT_AMBIGUITY_THRESHOLD,
		parse: value => {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
				return {
					kind: "invalid",
					reason: "expected gjc.deepInterview.ambiguityThreshold to be a number in (0, 1]",
				};
			}
			return { kind: "valid", value };
		},
		// The session's effective agent profile: an SDK session created with
		// `createAgentSession({ agentDir })` resolves against that directory
		// instead of the process-global default.
		agentDir: agentDir ?? (isSettingsInitialized() ? Settings.instance.getAgentDir() : undefined),
	});
	if (resolution.source === "default") return undefined;
	return { threshold: resolution.value, source: resolution.source };
}

function englishLanguagePreference(): DeepInterviewLanguagePreference {
	return {
		code: "en",
		label: "English",
		source: "explicit-user-request",
		instruction:
			"Ask every user-facing deep-interview question in English because the user explicitly requested English.",
	};
}

function userLanguagePreference(): DeepInterviewLanguagePreference {
	return {
		code: "user",
		label: "User language",
		source: "initial-idea",
		instruction:
			"Ask every user-facing deep-interview question in the user/session language inferred from the initial idea unless the user explicitly requests another language. Keep code identifiers, file paths, commands, settings/JSON keys, library/API names, and quoted source text unchanged when appropriate.",
	};
}

function resolveDeepInterviewLanguagePreference(idea: string): DeepInterviewLanguagePreference | undefined {
	if (/\b(?:answer|ask|respond|reply|write|use|speak)\s+(?:only\s+)?in\s+English\b/i.test(idea)) {
		return englishLanguagePreference();
	}
	if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(idea)) {
		return userLanguagePreference();
	}
	return undefined;
}

function isDeepInterviewSpecWriteInvocation(args: readonly string[]): boolean {
	return hasFlag(args, "--write");
}

async function resolveSpecWriteArgs(args: readonly string[], cwd: string): Promise<ResolvedDeepInterviewSpecWriteArgs> {
	const stage = flagValue(args, "--stage")?.trim() || "final";
	if (stage !== "final") {
		throw new DeepInterviewCommandError(2, 'unknown --stage for deep-interview --write: expected "final"');
	}

	const slug = flagValue(args, "--slug")?.trim() || defaultSpecSlug();
	assertSafePathComponent(slug, "slug");

	const rawSpec = flagValue(args, "--spec");
	if (rawSpec === undefined || rawSpec === "") {
		throw new DeepInterviewCommandError(2, "--spec is required for deep-interview --write");
	}

	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const sessionId = session.gjcSessionId;
	assertSafePathComponent(sessionId, "session-id");

	const rawHandoff = flagValue(args, "--handoff")?.trim() || undefined;
	if (rawHandoff && rawHandoff !== "ralplan") {
		throw new DeepInterviewCommandError(2, 'unknown --handoff target: expected "ralplan"');
	}

	const allowedFlags = new Set([
		"--write",
		"--stage",
		"--slug",
		"--spec",
		"--session-id",
		"--handoff",
		"--deliberate",
		"--json",
		"--force",
	]);
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (["--stage", "--slug", "--spec", "--session-id", "--handoff"].includes(arg)) {
			skipNext = true;
			continue;
		}
		if (arg.startsWith("-") && !allowedFlags.has(arg)) {
			throw new DeepInterviewCommandError(2, `unknown flag for gjc deep-interview --write: ${arg}`);
		}
	}

	return {
		stage: "final",
		slug,
		spec: await resolveSpecContent(rawSpec, cwd),
		sessionId,
		json: hasFlag(args, "--json"),
		deliberate: hasFlag(args, "--deliberate"),
		force: hasFlag(args, "--force"),
		handoff: rawHandoff as "ralplan" | undefined,
	};
}

async function resolveDeepInterviewArgs(
	args: readonly string[],
	cwd: string,
	agentDir?: string,
): Promise<ResolvedDeepInterviewArgs> {
	const session = resolveGjcSessionForWrite(cwd, {
		flagValue: flagValue(args, "--session-id"),
		envSessionId: process.env.GJC_SESSION_ID,
	});
	const sessionId = session.gjcSessionId;
	assertSafePathComponent(sessionId, "session-id");

	const explicitResolutions = (["quick", "standard", "deep"] as const).filter(name => hasFlag(args, `--${name}`));
	if (explicitResolutions.length > 1) {
		throw new DeepInterviewCommandError(2, "pass at most one of --quick, --standard, --deep");
	}
	const resolution: DeepInterviewResolution | undefined = explicitResolutions[0];

	// Precedence: --threshold > settings.json (project then user) > resolution flag default > 0.05.
	let threshold: number = DEFAULT_AMBIGUITY_THRESHOLD;
	let thresholdSource = "default";
	const thresholdOverride = flagValue(args, "--threshold");
	if (thresholdOverride !== undefined) {
		const parsed = Number(thresholdOverride);
		if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
			throw new DeepInterviewCommandError(
				2,
				`invalid --threshold: ${thresholdOverride}. Expected 0 < threshold <= 1.`,
			);
		}
		threshold = parsed;
		thresholdSource = flagValue(args, "--threshold-source")?.trim() || "flag:--threshold";
	} else {
		const configured = await resolveConfiguredAmbiguityThreshold(cwd, agentDir);
		if (configured) {
			threshold = configured.threshold;
			thresholdSource = configured.source;
		} else if (resolution) {
			threshold = RESOLUTION_THRESHOLDS[resolution];
			thresholdSource = `flag:--${resolution}`;
		}
	}

	const ideaParts: string[] = [];
	let skipNext = false;
	for (const arg of args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (VALUE_FLAGS.has(arg)) {
			skipNext = true;
			continue;
		}
		if (arg === "--trace") continue;
		if (arg === "--quick" || arg === "--standard" || arg === "--deep" || arg === "--json") continue;
		if (arg.startsWith("-")) {
			throw new DeepInterviewCommandError(2, `unknown flag for gjc deep-interview: ${arg}`);
		}
		ideaParts.push(arg);
	}
	const idea = ideaParts.join(" ").trim();
	assertDeepInterviewInputWithinLimit(idea, MAX_INITIAL_CONTEXT_LENGTH, "initial_idea");
	const effectiveResolution: DeepInterviewResolution = resolution ?? "standard";
	const trace = hasFlag(args, "--trace") && idea ? await buildDeepInterviewTraceSummary(cwd, idea) : undefined;
	return {
		resolution: effectiveResolution,
		threshold,
		thresholdSource,
		sessionId,
		idea,
		language: resolveDeepInterviewLanguagePreference(idea),
		trace,
		json: hasFlag(args, "--json"),
	};
}

function intentIdsInSpec(content: string): string[] {
	const ids = content.match(/(?:artifact|surface|integration|constraint):[a-z0-9][a-z0-9._/-]{0,127}/g) ?? [];
	return [...new Set(ids)].sort();
}

function resolveLockedIntentReview(existing: unknown, content: string): DeepInterviewIntentReview | undefined {
	const envelope = normalizeDeepInterviewEnvelope(existing);
	const state = envelope.state;
	if (!state) return undefined;
	if (state.intent_contract === undefined) {
		if (state.intent_contract_required === true)
			throw new DeepInterviewCommandError(
				2,
				"deep-interview locked intent blocks spec persistence: missing Round 0 intent contract",
			);
		return undefined;
	}
	const locked = state.intent_contract as DeepInterviewIntentManifest;
	const observedIds = intentIdsInSpec(content);
	const rounds = Array.isArray(state.rounds)
		? state.rounds
				.filter(
					(round): round is Record<string, unknown> =>
						Boolean(round) && typeof round === "object" && !Array.isArray(round),
				)
				.map(round => ({ round: round.round, answer_hash: round.answer_hash }))
		: [];
	try {
		if (state.intent_review === undefined) {
			if (locked.items.some(item => !observedIds.includes(item.id))) throw new Error("missing intent review");
			const lockedById = new Map(locked.items.map(item => [item.id, item]));
			const observedItems: DeepInterviewIntentItem[] = observedIds.map(id => {
				const existingItem = lockedById.get(id);
				if (existingItem) return existingItem;
				return {
					id,
					category: id.slice(0, id.indexOf(":")) as DeepInterviewIntentCategory,
					statement: id,
				};
			});
			return reviewDeepInterviewIntent(locked, observedItems, {
				status: "not_required",
				supporting_substitutions: [],
			});
		}
		assertDeepInterviewIntentReview(state.intent_review, locked, observedIds, rounds);
		return state.intent_review as DeepInterviewIntentReview;
	} catch (error) {
		throw new DeepInterviewCommandError(
			2,
			`deep-interview locked intent blocks spec persistence: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function persistDeepInterviewSpec(
	cwd: string,
	resolved: ResolvedDeepInterviewSpecWriteArgs,
): Promise<PersistedDeepInterviewSpec> {
	return withWorkflowStateLock(
		deepInterviewStatePath(cwd, resolved.sessionId),
		() => persistDeepInterviewSpecUnlocked(cwd, resolved),
		{ cwd },
	);
}

async function persistDeepInterviewSpecUnlocked(
	cwd: string,
	resolved: ResolvedDeepInterviewSpecWriteArgs,
): Promise<PersistedDeepInterviewSpec> {
	assertDeepInterviewInputWithinLimit(
		resolved.spec,
		MAX_DEEP_INTERVIEW_STRUCTURED_RESPONSE_LENGTH,
		"structured deep-interview response",
	);
	const statePath = deepInterviewStatePath(cwd, resolved.sessionId);
	const existingRead = await readExistingStateForMutation(statePath);
	if (existingRead.kind === "corrupt" && !resolved.force) {
		throw new DeepInterviewCommandError(
			2,
			`existing deep-interview state is corrupt or tampered (${existingRead.error}); use --force to overwrite ${statePath}`,
		);
	}
	if (existingRead.kind === "valid") assertNoFutureDeepInterviewEnvelope(existingRead.value, "spec publication state");
	const existing = existingRead.kind === "valid" ? existingRead.value : {};
	const existingInner =
		existing.state && typeof existing.state === "object" && !Array.isArray(existing.state)
			? (existing.state as Record<string, unknown>)
			: undefined;
	if (existingInner?.crystal !== undefined) {
		throw new DeepInterviewCommandError(2, "direct spec write is unavailable while canonical Crystal state exists");
	}

	const content = resolved.spec.endsWith("\n") ? resolved.spec : `${resolved.spec}\n`;
	const intentReview = resolveLockedIntentReview(existing, content);
	const specPath = path.join(sessionSpecsDir(cwd, resolved.sessionId), `deep-interview-${resolved.slug}.md`);
	await writeArtifact(specPath, content, {
		cwd,
		audit: {
			category: "artifact",
			verb: "write",
			owner: "gjc-runtime",
			skill: "deep-interview",
			sessionId: resolved.sessionId,
		},
	});

	const sha256 = createHash("sha256").update(content).digest("hex");
	const createdAt = new Date().toISOString();
	await appendJsonl(
		path.join(sessionSpecsDir(cwd, resolved.sessionId), "deep-interview-index.jsonl"),
		{ slug: resolved.slug, stage: resolved.stage, path: specPath, created_at: createdAt, sha256 },
		{
			cwd,
			audit: {
				category: "ledger",
				verb: "append",
				owner: "gjc-runtime",
				skill: "deep-interview",
				sessionId: resolved.sessionId,
			},
		},
	);

	const payload = normalizeDeepInterviewEnvelope({
		...existing,
		active: true,
		current_phase: "handoff",
		skill: "deep-interview",
		version: WORKFLOW_STATE_VERSION,
		spec_slug: resolved.slug,
		spec_path: specPath,
		spec_sha256: sha256,
		spec_stage: resolved.stage,
		spec_persisted_at: createdAt,
		updated_at: createdAt,
	}) as Record<string, unknown>;
	if (intentReview) {
		const state = payload.state as Record<string, unknown>;
		state.intent_review = intentReview;
	}
	if (resolved.sessionId) payload.session_id = resolved.sessionId;
	await writeWorkflowEnvelopeAtomic(statePath, payload, {
		cwd,
		lockHeld: true,
		receipt: {
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: "gjc deep-interview persist-spec-state",
			sessionId: resolved.sessionId,
			nowIso: createdAt,
		},
		audit: {
			category: "state",
			verb: "write",
			owner: "gjc-runtime",
			skill: "deep-interview",
			sessionId: resolved.sessionId,
			forced: resolved.force,
		},
	});
	await writeSessionActivityMarker(cwd, resolved.sessionId, { writer: "deep-interview-runtime", path: statePath });
	await syncDeepInterviewHud({
		cwd,
		sessionId: resolved.sessionId,
		payload,
		phase: "handoff",
		specStatus: "persisted",
	});

	return {
		slug: resolved.slug,
		path: specPath,
		stage: resolved.stage,
		sha256,
		createdAt,
		statePath,
	};
}

async function seedDeepInterviewState(cwd: string, resolved: ResolvedDeepInterviewArgs): Promise<string> {
	const statePath = deepInterviewStatePath(cwd, resolved.sessionId);
	return withWorkflowStateLock(statePath, () => seedDeepInterviewStateUnlocked(cwd, resolved), { cwd });
}

async function seedDeepInterviewStateUnlocked(cwd: string, resolved: ResolvedDeepInterviewArgs): Promise<string> {
	const statePath = deepInterviewStatePath(cwd, resolved.sessionId);
	assertDeepInterviewInputWithinLimit(resolved.idea, MAX_INITIAL_CONTEXT_LENGTH, "initial_idea");
	const existingRead = await readExistingStateForMutation(statePath);
	if (existingRead.kind === "valid") {
		assertNoFutureDeepInterviewEnvelope(existingRead.value, "seed state");
		const existingInner = isRecord(existingRead.value.state) ? existingRead.value.state : undefined;
		if (existingInner?.crystal !== undefined)
			throw new DeepInterviewCommandError(2, "deep-interview seed cannot replace canonical Crystal state");
	}
	const now = new Date().toISOString();
	const payload: Record<string, unknown> = {
		active: true,
		current_phase: "interviewing",
		skill: "deep-interview",
		version: WORKFLOW_STATE_VERSION,
		resolution: resolved.resolution,
		threshold: resolved.threshold,
		threshold_source: resolved.thresholdSource,
		state: {
			initial_idea: resolved.idea,
			intent_contract_required: true,
			rounds: [],
			established_facts: [],
			current_ambiguity: 1.0,
			threshold: resolved.threshold,
			threshold_source: resolved.thresholdSource,
		},
		updated_at: now,
	};
	if (resolved.trace) {
		payload.trace = resolved.trace;
		(payload.state as Record<string, unknown>).trace = resolved.trace;
		(payload.state as Record<string, unknown>).trace_summary = resolved.trace;
		(payload.state as Record<string, unknown>).codebase_context = {
			source: "trace",
			summary: resolved.trace.findings,
			relevant_paths: resolved.trace.relevant_paths,
			project_hints: resolved.trace.project_hints,
		};
	}
	if (resolved.language) {
		payload.language = resolved.language;
		(payload.state as Record<string, unknown>).language = resolved.language;
	}
	if (resolved.sessionId) payload.session_id = resolved.sessionId;
	await writeWorkflowEnvelopeAtomic(statePath, payload, {
		cwd,
		lockHeld: true,
		receipt: {
			cwd,
			skill: "deep-interview",
			owner: "gjc-runtime",
			command: "gjc deep-interview seed",
			sessionId: resolved.sessionId,
			nowIso: now,
		},
		audit: {
			category: "state",
			verb: "write",
			owner: "gjc-runtime",
			skill: "deep-interview",
			sessionId: resolved.sessionId,
		},
	});
	await writeSessionActivityMarker(cwd, resolved.sessionId, { writer: "deep-interview-runtime", path: statePath });
	await syncDeepInterviewHud({ cwd, sessionId: resolved.sessionId, payload, phase: "interviewing" });
	return statePath;
}

async function syncDeepInterviewHud(options: {
	cwd: string;
	sessionId?: string;
	payload: Record<string, unknown>;
	phase?: string;
	specStatus?: string;
}): Promise<void> {
	try {
		const phase =
			options.phase ??
			(typeof options.payload.current_phase === "string" ? options.payload.current_phase : "interviewing");
		await syncSkillActiveState({
			cwd: options.cwd,
			skill: "deep-interview",
			active: phase !== "complete",
			phase,
			sessionId: options.sessionId,
			source: "gjc-deep-interview-native",
			hud: deriveDeepInterviewHud(options.payload, { phase, specStatus: options.specStatus }),
		});
	} catch {
		// HUD sync is best-effort and must not change command semantics.
	}
}

async function handleSpecWrite(
	args: readonly string[],
	cwd: string,
	agentDir?: string,
): Promise<DeepInterviewCommandResult> {
	const resolved = await resolveSpecWriteArgs(args, cwd);
	const persisted = await persistDeepInterviewSpec(cwd, resolved);
	const shouldHandoff = resolved.deliberate || resolved.handoff === "ralplan";
	const summary: DeepInterviewSpecWriteSummary = {
		skill: "deep-interview",
		stage: persisted.stage,
		slug: persisted.slug,
		path: persisted.path,
		sha256: persisted.sha256,
		spec_path: persisted.path,
		sha: persisted.sha256,
		created_at: persisted.createdAt,
		state_path: persisted.statePath,
	};

	if (shouldHandoff) {
		const ralplanArgs = ["--deliberate", "--json"];
		if (resolved.sessionId) ralplanArgs.push("--session-id", resolved.sessionId);
		ralplanArgs.push(persisted.path);
		const ralplanResult = await runNativeRalplanCommand(ralplanArgs, cwd, { agentDir });
		if (ralplanResult.status !== 0) {
			throw new DeepInterviewCommandError(
				ralplanResult.status,
				ralplanResult.stderr?.trim() || "failed to seed ralplan",
			);
		}

		const handoffArgs = ["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"];
		if (resolved.sessionId) handoffArgs.push("--session-id", resolved.sessionId);
		else handoffArgs.push("--session-id", "");
		const handoffResult = await runNativeStateCommand(handoffArgs, cwd);
		if (handoffResult.status !== 0) {
			throw new DeepInterviewCommandError(
				handoffResult.status,
				handoffResult.stderr?.trim() || "failed to hand off deep-interview to ralplan",
			);
		}

		const ralplanPayload = ralplanResult.stdout ? (JSON.parse(ralplanResult.stdout) as Record<string, unknown>) : {};
		summary.handoff = {
			to: "ralplan",
			mode: "deliberate",
			state_path: typeof ralplanPayload.state_path === "string" ? ralplanPayload.state_path : undefined,
			run_id: typeof ralplanPayload.run_id === "string" ? ralplanPayload.run_id : undefined,
		};
	}

	const stdout = resolved.json
		? `${JSON.stringify(summary)}\n`
		: [
				`deep-interview spec_path=${persisted.path}`,
				`sha=${persisted.sha256}`,
				`state_path=${persisted.statePath}`,
				shouldHandoff
					? `handoff=ralplan run_id=${summary.handoff?.run_id ?? ""} state_path=${summary.handoff?.state_path ?? ""}`
					: undefined,
				"",
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
	return { status: 0, stdout };
}

export async function runNativeDeepInterviewCommand(
	args: string[],
	cwd = process.cwd(),
	options: { agentDir?: string } = {},
): Promise<DeepInterviewCommandResult> {
	try {
		const [firstArg, ...restArgs] = args;
		if (firstArg === "approve-execution")
			return await runNativeStateCommand(["approve-execution", "--mode", "deep-interview", ...restArgs], cwd);
		if (isDeepInterviewStageVerb(firstArg)) return await runDeepInterviewStageCommand(firstArg, restArgs, cwd);
		if (hasFlag(args, "--crystallize")) return await handleCrystallize(args, cwd);
		if (isDeepInterviewSpecWriteInvocation(args)) return await handleSpecWrite(args, cwd, options.agentDir);
		const resolved = await resolveDeepInterviewArgs(args, cwd, options.agentDir);
		if (!resolved.idea) {
			throw new DeepInterviewCommandError(
				2,
				'gjc deep-interview requires an idea, e.g. `gjc deep-interview "<idea>"`.',
			);
		}
		const statePath = await seedDeepInterviewState(cwd, resolved);

		const summary = {
			skill: "deep-interview",
			resolution: resolved.resolution,
			threshold: resolved.threshold,
			threshold_source: resolved.thresholdSource,
			idea: resolved.idea,
			language: resolved.language,
			trace: resolved.trace,
			state_path: statePath,
			handoff: "/skill:deep-interview",
		};
		const stdout = resolved.json
			? `${JSON.stringify(summary)}\n`
			: [
					`deep-interview seed state_path=${statePath}`,
					`resolution=${resolved.resolution} threshold=${resolved.threshold} threshold_source=${resolved.thresholdSource}`,
					resolved.trace ? `trace=enabled bounded_paths=${resolved.trace.relevant_paths.length}` : undefined,
					"handoff=/skill:deep-interview",
					"",
				].join("\n");
		return { status: 0, stdout };
	} catch (error) {
		if (error instanceof CommandError) return { status: error.exitStatus, stderr: `${error.message}\n` };
		return { status: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}
