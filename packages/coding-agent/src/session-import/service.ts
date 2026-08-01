import { createHash, type Hash, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir, getSessionsDir } from "@gajae-code/utils";
import {
	listManagedCandidates,
	managedRootForScope,
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScopeForWrite,
} from "../session/internal/managed-session-scope";
import {
	acquireManagedLock,
	ManagedPublishError,
	ManagedSessionDescendantStore,
	type ManagedStorageLock,
	ManagedTreeMoveOutcomeError,
} from "../session/internal/managed-session-storage";
import { type ResumeSessionIdentity, SessionManager } from "../session/session-manager";
import {
	assertCodexWorkspaceIdentity,
	CODEX_CONVERTER_VERSION,
	CODEX_MAPPING_VERSION,
	CODEX_PROVIDER_ID,
	CODEX_SANITIZER_VERSION,
	type CodexConversion,
	CodexImportError,
	type CodexMappedEvent,
	type CodexSessionSource,
	closeCodexSessionAuthorities,
	convertCodexSession,
	discoverCodexSessions,
	sanitizeImportedString,
} from "./codex";

const TARGET_TRANSCRIPT_MAX_BYTES = 128 * 1024 * 1024;
const TARGET_LINE_MAX_BYTES = 16 * 1024 * 1024;
const IMPORT_INTERNAL_DIRECTORY = ".gjc-managed-session-internal";
const IMPORT_LOCKS_DIRECTORY = "locks";
const IMPORT_STAGING_DIRECTORY = "import-staging";
const IMPORT_RECOVERY_RECEIPT = "artifact-recovery.json";
const IMPORT_BUFFER_BYTES = 1024 * 1024;
const IMPORT_ARTIFACT_DIRECTORY =
	/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export type SessionImportErrorCode =
	| CodexImportError["code"]
	| "invalid_request"
	| "binding_invalid"
	| "content_too_large"
	| "destination_conflict"
	| "publish_uncertain"
	| "atomic_unavailable"
	| "durability_not_provable"
	| "durability_failed"
	| "identity_mismatch"
	| "validation_failed"
	| "io_failed"
	| "internal_failed";

export interface SessionImportFailure {
	status: "failed";
	provider: "codex";
	sourceSessionId?: string;
	code: SessionImportErrorCode;
	phase: string;
	retryable: boolean;
	message: string;
	limitBytes?: number;
	observedBytes?: number;
	causeCode?: string;
}

export interface SessionImportSuccess {
	status: "imported" | "existing";
	provider: "codex";
	sourceSessionId: string;
	targetSessionId: string;
	targetPath: string;
	sourceBytes: number;
	transcriptBytes: number;
	mappedEvents: number;
	quarantinedEvents: number;
	redactedValues: number;
}

export type SessionImportResult = SessionImportSuccess | SessionImportFailure;

export interface SessionImportBatchResult {
	provider: "codex";
	status: "success" | "partial" | "failed" | "existing";
	results: SessionImportResult[];
}

interface ImportProvenance {
	schemaVersion: 1;
	providerId: typeof CODEX_PROVIDER_ID;
	sourceSessionId: string;
	sourceSha256: string;
	converterVersion: number;
	sanitizerVersion: number;
	mappingVersion: number;
	targetSessionId: string;
	sourceBytes: number;
	transcriptBytes: number;
	counts: CodexConversion["counts"];
	quarantine: { present: boolean; truncated: boolean; sha256?: string };
	source: { workspaceSha256: string; cliVersion?: string; modelProvider?: string };
}

interface ImportManifest {
	schemaVersion: 1;
	provenance: ImportProvenance;
	transcriptSha256: string;
}
interface ImportRecoveryReceipt {
	schemaVersion: 1;
	artifactDirectory: string;
	importKey: string;
	targetSessionId: string;
}

interface StagedTranscript {
	relativePath: string;
	absolutePath: string;
	bytes: number;
	sha256: string;
	provenance: ImportProvenance;
}

function entryId(): string {
	return randomUUID().replaceAll("-", "");
}

function timestampMs(timestamp: string): number {
	const value = Date.parse(timestamp);
	return Number.isFinite(value) ? value : 0;
}

function assistantEnvelope(content: unknown[], timestamp: string, stopReason: "stop" | "toolUse") {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: CODEX_PROVIDER_ID,
		model: "codex-imported-history",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: timestampMs(timestamp),
	};
}

function importKey(conversion: CodexConversion): string {
	return [
		CODEX_PROVIDER_ID,
		conversion.source.id,
		conversion.sourceSha256,
		CODEX_CONVERTER_VERSION,
		CODEX_SANITIZER_VERSION,
		CODEX_MAPPING_VERSION,
	].join(":");
}
function provenanceKey(provenance: ImportProvenance): string {
	return [
		provenance.providerId,
		provenance.sourceSessionId,
		provenance.sourceSha256,
		provenance.converterVersion,
		provenance.sanitizerVersion,
		provenance.mappingVersion,
	].join(":");
}

function stableTargetSessionId(key: string): string {
	const digest = createHash("sha256").update(key).digest("hex");
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function makeEntry(
	id: string,
	parentId: string | null,
	timestamp: string,
	value: Record<string, unknown>,
): Record<string, unknown> & { id: string; parentId: string | null; timestamp: string } {
	return { ...value, id, parentId, timestamp };
}

function quarantineBytes(conversion: CodexConversion): Buffer | null {
	if (conversion.quarantine.length === 0) return null;
	return Buffer.from(`${conversion.quarantine.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

class BufferedFileWriter {
	readonly #handle: fs.FileHandle;
	#pending: Buffer[] = [];
	#pendingBytes = 0;
	bytes = 0;

	constructor(handle: fs.FileHandle) {
		this.#handle = handle;
	}

	async write(bytes: Uint8Array): Promise<void> {
		const copy = Buffer.from(bytes);
		this.#pending.push(copy);
		this.#pendingBytes += copy.byteLength;
		this.bytes += copy.byteLength;
		if (this.#pendingBytes >= IMPORT_BUFFER_BYTES) await this.flush();
	}

	async line(value: unknown): Promise<void> {
		await this.write(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
	}

	async flush(): Promise<void> {
		if (this.#pendingBytes === 0) return;
		await this.#handle.write(Buffer.concat(this.#pending, this.#pendingBytes));
		this.#pending = [];
		this.#pendingBytes = 0;
	}
}

async function streamFileIntoWriter(sourcePath: string, writer: BufferedFileWriter, hash: Hash): Promise<void> {
	const source = await fs.open(sourcePath, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
	try {
		const stat = await source.stat();
		if (!stat.isFile() || stat.nlink !== 1) throw new Error("source_untrusted");
		const chunk = Buffer.allocUnsafe(IMPORT_BUFFER_BYTES);
		let position = 0;
		for (;;) {
			const { bytesRead } = await source.read(chunk, 0, chunk.length, position);
			if (bytesRead === 0) break;
			const bytes = chunk.subarray(0, bytesRead);
			hash.update(bytes);
			await writer.write(bytes);
			position += bytesRead;
		}
	} finally {
		await source.close();
	}
}

async function validateExactV5(file: string, expectedSessionId: string, expectedBytes: number): Promise<void> {
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== expectedBytes)
		throw new Error("validation_failed");
	const stream = nodeFs.createReadStream(file);
	const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	let lineNumber = 0;
	let priorId: string | null = null;
	const entryIds = new Set<string>();
	const toolCallIds = new Set<string>();
	try {
		for await (const line of reader) {
			lineNumber++;
			if (Buffer.byteLength(line, "utf8") > TARGET_LINE_MAX_BYTES)
				throw new CodexImportError(
					"content_too_large",
					"source_event",
					"Converted GJC transcript contains an oversized entry.",
					TARGET_LINE_MAX_BYTES,
					Buffer.byteLength(line, "utf8"),
				);
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				throw new Error("validation_failed");
			}
			if (lineNumber === 1) {
				if (record.type !== "session" || record.version !== 5 || record.id !== expectedSessionId)
					throw new Error("validation_failed");
				entryIds.add(expectedSessionId);
				continue;
			}
			if (
				typeof record.id !== "string" ||
				entryIds.has(record.id) ||
				record.parentId !== priorId ||
				typeof record.timestamp !== "string" ||
				!Number.isFinite(Date.parse(record.timestamp))
			)
				throw new Error("validation_failed");
			entryIds.add(record.id);
			if (record.type === "model_change") {
				if (lineNumber !== 2 || typeof record.model !== "string") throw new Error("validation_failed");
			} else if (record.type === "custom") {
				if (
					lineNumber !== 3 ||
					record.customType !== "session-import-provenance" ||
					!record.data ||
					typeof record.data !== "object"
				)
					throw new Error("validation_failed");
			} else if (record.type === "message") {
				const message = record.message;
				if (!message || typeof message !== "object") throw new Error("validation_failed");
				const value = message as Record<string, unknown>;
				const role = String(value.role);
				const content = value.content;
				if (!["user", "assistant", "toolResult"].includes(role)) throw new Error("validation_failed");
				if (role === "user" && typeof content === "string") {
					if (content.length === 0) throw new Error("validation_failed");
				} else if (!Array.isArray(content)) throw new Error("validation_failed");
				if (role === "toolResult") {
					if (
						typeof value.toolCallId !== "string" ||
						!toolCallIds.has(value.toolCallId) ||
						typeof value.toolName !== "string"
					)
						throw new Error("validation_failed");
				}
				if (!Array.isArray(content)) {
					priorId = record.id;
					continue;
				}
				for (const itemValue of content) {
					if (!itemValue || typeof itemValue !== "object") throw new Error("validation_failed");
					const item = itemValue as Record<string, unknown>;
					if (item.type === "text") {
						if (typeof item.text !== "string") throw new Error("validation_failed");
					} else if (role === "assistant" && item.type === "toolCall") {
						if (
							typeof item.id !== "string" ||
							toolCallIds.has(item.id) ||
							typeof item.name !== "string" ||
							!item.arguments ||
							typeof item.arguments !== "object"
						)
							throw new Error("validation_failed");
						toolCallIds.add(item.id);
					} else throw new Error("validation_failed");
				}
			} else throw new Error("validation_failed");
			priorId = record.id;
		}
	} finally {
		reader.close();
		stream.destroy();
	}
	if (lineNumber < 3) throw new Error("validation_failed");
}

async function hashFileWithPrefix(
	file: string,
	prefixBytes: number,
	expected: ResumeSessionIdentity,
): Promise<{ totalBytes: number; prefixSha256: string; fullSha256: string }> {
	const canonicalPath = await fs.realpath(file);
	if (canonicalPath !== expected.canonicalPath) throw new Error("validation_failed");
	const handle = await fs.open(file, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
	const prefixDigest = createHash("sha256");
	const fullDigest = createHash("sha256");
	let totalBytes = 0;
	try {
		const initial = await handle.stat({ bigint: true });
		if (
			!initial.isFile() ||
			initial.nlink !== 1n ||
			initial.dev !== expected.dev ||
			initial.ino !== expected.ino ||
			Number(initial.size) !== expected.size ||
			initial.mtimeNs !== expected.mtimeNs ||
			initial.size < BigInt(prefixBytes)
		)
			throw new Error("validation_failed");
		const chunk = Buffer.allocUnsafe(IMPORT_BUFFER_BYTES);
		for (;;) {
			const result = await handle.read(chunk, 0, chunk.length, totalBytes);
			if (result.bytesRead === 0) break;
			const bytes = chunk.subarray(0, result.bytesRead);
			fullDigest.update(bytes);
			if (totalBytes < prefixBytes)
				prefixDigest.update(bytes.subarray(0, Math.min(bytes.length, prefixBytes - totalBytes)));
			totalBytes += result.bytesRead;
		}
		const terminal = await handle.stat({ bigint: true });
		const named = await fs.lstat(file, { bigint: true });
		if (
			totalBytes !== expected.size ||
			terminal.dev !== initial.dev ||
			terminal.ino !== initial.ino ||
			terminal.size !== initial.size ||
			terminal.mtimeNs !== initial.mtimeNs ||
			terminal.ctimeNs !== initial.ctimeNs ||
			terminal.nlink !== 1n ||
			named.dev !== initial.dev ||
			named.ino !== initial.ino ||
			named.size !== initial.size ||
			named.mtimeNs !== initial.mtimeNs ||
			named.ctimeNs !== initial.ctimeNs ||
			named.nlink !== 1n ||
			named.isSymbolicLink() ||
			(await fs.realpath(file)) !== expected.canonicalPath
		)
			throw new Error("validation_failed");
	} finally {
		await handle.close();
	}
	return {
		totalBytes,
		prefixSha256: prefixDigest.digest("hex"),
		fullSha256: fullDigest.digest("hex"),
	};
}

async function hashBoundedAttachment(file: string, maxBytes: number): Promise<string | null> {
	const handle = await fs.open(file, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW).catch(() => null);
	if (!handle) return null;
	const digest = createHash("sha256");
	let offset = 0;
	try {
		const initial = await handle.stat({ bigint: true });
		if (!initial.isFile() || initial.nlink !== 1n || initial.size > BigInt(maxBytes)) return null;
		const chunk = Buffer.allocUnsafe(IMPORT_BUFFER_BYTES);
		for (;;) {
			const result = await handle.read(chunk, 0, chunk.length, offset);
			if (result.bytesRead === 0) break;
			digest.update(chunk.subarray(0, result.bytesRead));
			offset += result.bytesRead;
		}
		const terminal = await handle.stat({ bigint: true });
		const named = await fs.lstat(file, { bigint: true });
		if (
			BigInt(offset) !== initial.size ||
			terminal.dev !== initial.dev ||
			terminal.ino !== initial.ino ||
			terminal.size !== initial.size ||
			terminal.mtimeNs !== initial.mtimeNs ||
			terminal.ctimeNs !== initial.ctimeNs ||
			terminal.nlink !== 1n ||
			named.dev !== initial.dev ||
			named.ino !== initial.ino ||
			named.size !== initial.size ||
			named.mtimeNs !== initial.mtimeNs ||
			named.ctimeNs !== initial.ctimeNs ||
			named.nlink !== 1n ||
			named.isSymbolicLink()
		)
			return null;
		return digest.digest("hex");
	} finally {
		await handle.close();
	}
}

function isManifest(value: unknown): value is ImportManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const manifest = value as Partial<ImportManifest>;
	return manifest.schemaVersion === 1 && manifest.provenance?.schemaVersion === 1;
}

async function readManifest(file: string): Promise<ImportManifest | null> {
	try {
		const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
		return isManifest(value) ? value : null;
	} catch {
		return null;
	}
}
async function readTranscriptProvenance(file: string): Promise<ImportProvenance | null> {
	try {
		const handle = await fs.open(file, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
		try {
			const buffer = Buffer.alloc(512 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
				if (!line.includes('"customType":"session-import-provenance"')) continue;
				const entry = JSON.parse(line) as { customType?: string; data?: ImportProvenance };
				if (entry.customType === "session-import-provenance" && entry.data?.schemaVersion === 1) return entry.data;
			}
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
	return null;
}

async function findExisting(
	scope: Parameters<typeof listManagedCandidates>[0],
	key: string,
): Promise<SessionImportSuccess | null> {
	const listing = listManagedCandidates(scope);
	if (listing.kind !== "complete") return null;
	for (const candidate of listing.owned) {
		const artifactDirectory = candidate.path.slice(0, -6);
		const manifestPath = path.join(artifactDirectory, "codex-import-manifest.json");
		const manifest = await readManifest(manifestPath);
		if (!manifest) continue;
		const provenance = manifest.provenance;
		const candidateKey = provenanceKey(provenance);
		if (candidateKey !== key || provenance.targetSessionId !== candidate.sessionId) continue;
		const transcriptProvenance = await readTranscriptProvenance(candidate.path);
		if (!transcriptProvenance || JSON.stringify(transcriptProvenance) !== JSON.stringify(provenance)) continue;
		const quarantinePath = path.join(artifactDirectory, "codex-quarantine.jsonl");
		if (provenance.quarantine.present) {
			if (
				!provenance.quarantine.sha256 ||
				(await hashBoundedAttachment(quarantinePath, 8 * 1024 * 1024)) !== provenance.quarantine.sha256
			)
				continue;
		} else if (await fs.lstat(quarantinePath).catch(() => null)) continue;
		const inspection = await SessionManager.inspectSessionTailReadOnly(candidate.path);
		if (inspection.kind === "error" || inspection.identity.sessionId !== candidate.sessionId) continue;
		const observed = await hashFileWithPrefix(candidate.path, provenance.transcriptBytes, inspection.identity).catch(
			() => null,
		);
		if (
			!observed ||
			observed.prefixSha256 !== manifest.transcriptSha256 ||
			observed.fullSha256 !== inspection.identity.sha256
		)
			continue;
		return {
			status: "existing",
			provider: "codex",
			sourceSessionId: provenance.sourceSessionId,
			targetSessionId: candidate.sessionId,
			targetPath: candidate.path,
			sourceBytes: provenance.sourceBytes,
			transcriptBytes: observed.totalBytes,
			mappedEvents: provenance.counts.mapped,
			quarantinedEvents: provenance.counts.quarantined,
			redactedValues: provenance.counts.redacted,
		};
	}
	return null;
}

function classifyFailure(error: unknown, sourceSessionId?: string): SessionImportFailure {
	if (error instanceof CodexImportError) {
		return {
			status: "failed",
			provider: "codex",
			sourceSessionId,
			code: error.code,
			phase: error.phase,
			retryable: error.code === "source_changed",
			message: error.message,
			limitBytes: error.limitBytes,
			observedBytes: error.observedBytes,
		};
	}
	if (error instanceof ManagedPublishError) {
		const code: SessionImportErrorCode = !error.stagingCleanupSafe
			? "publish_uncertain"
			: error.classification === "io_error"
				? "io_failed"
				: error.classification;
		return {
			status: "failed",
			provider: "codex",
			sourceSessionId,
			code,
			phase: "publish",
			retryable: code === "publish_uncertain" || code === "destination_conflict" || code === "io_failed",
			message:
				code === "publish_uncertain"
					? "The session publication outcome is uncertain; retry will reconcile it."
					: `Session publication failed: ${code}.`,
			causeCode: error.classification,
		};
	}
	const message = error instanceof Error ? error.message : "Unknown import failure";
	if (
		message === "content_too_large" ||
		message === "artifact_capacity_exceeded" ||
		message.includes("capacity_exceeded")
	) {
		return {
			status: "failed",
			provider: "codex",
			sourceSessionId,
			code: "content_too_large",
			phase: "artifact",
			retryable: false,
			message: "Imported session artifacts exceed the managed storage limit.",
			causeCode: message,
		};
	}
	if (message.includes("destination_conflict"))
		return {
			status: "failed",
			provider: "codex",
			sourceSessionId,
			code: "destination_conflict",
			phase: "publish",
			retryable: true,
			message: "The imported session destination already exists.",
		};
	if (message === "validation_failed")
		return {
			status: "failed",
			provider: "codex",
			sourceSessionId,
			code: "validation_failed",
			phase: "validation",
			retryable: false,
			message: "The converted session failed exact v5 validation.",
		};
	return {
		status: "failed",
		provider: "codex",
		sourceSessionId,
		code: message === "binding_invalid" ? "binding_invalid" : "internal_failed",
		phase: "internal",
		retryable: false,
		message: message === "binding_invalid" ? "Managed session binding is invalid." : "Session import failed.",
		causeCode: message,
	};
}

async function removeStaging(store: ManagedSessionDescendantStore, relativePath: string): Promise<void> {
	try {
		const snapshot = store.captureTree(relativePath);
		store.removeTreeExpected(relativePath, snapshot);
	} catch {
		// Exact managed cleanup is best-effort; recovery owns ambiguous staging.
	}
}
async function readRecoveryReceipt(file: string): Promise<ImportRecoveryReceipt | null> {
	const handle = await fs.open(file, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW).catch(() => null);
	if (!handle) return null;
	try {
		const stat = await handle.stat({ bigint: true });
		if (!stat.isFile() || stat.nlink !== 1n || stat.size > 64n * 1024n) return null;
		const value = JSON.parse(await handle.readFile("utf8")) as ImportRecoveryReceipt;
		if (
			value.schemaVersion !== 1 ||
			typeof value.importKey !== "string" ||
			typeof value.targetSessionId !== "string" ||
			typeof value.artifactDirectory !== "string" ||
			!IMPORT_ARTIFACT_DIRECTORY.test(value.artifactDirectory)
		)
			return null;
		return value;
	} catch {
		return null;
	} finally {
		await handle.close();
	}
}
function readManifestFromSnapshot(
	store: ManagedSessionDescendantStore,
	relativePath: string,
	snapshot: ReturnType<ManagedSessionDescendantStore["captureTree"]>,
): ImportManifest | null {
	const manifestRelative = "codex-import-manifest.json";
	const entry = snapshot.entries.find(candidate => candidate.relativePath === manifestRelative);
	if (!entry) return null;
	if (entry.kind !== "file" || !entry.sha256) throw new Error("destination_conflict");
	const file = store.readExpected(`${relativePath}/${manifestRelative}`);
	if (
		!file ||
		file.identity.dev.toString() !== entry.dev ||
		file.identity.ino.toString() !== entry.ino ||
		file.identity.size.toString() !== entry.size ||
		createHash("sha256").update(file.bytes).digest("hex") !== entry.sha256
	)
		throw new Error("destination_conflict");
	try {
		const value = JSON.parse(file.bytes.toString("utf8")) as unknown;
		return isManifest(value) ? value : null;
	} catch {
		return null;
	}
}

async function reconcileStaleArtifactDirectory(
	store: ManagedSessionDescendantStore,
	scopeDirectory: string,
	relativePath: string,
	transcriptPath: string,
	expectedKey: string,
	expectedTargetSessionId: string,
): Promise<void> {
	const absolutePath = path.join(scopeDirectory, relativePath);
	const stat = await fs.lstat(absolutePath).catch(() => null);
	if (!stat) return;
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("destination_conflict");
	if (await fs.lstat(transcriptPath).catch(() => null)) throw new Error("destination_conflict");
	const snapshot = store.captureTree(relativePath);
	const manifest = readManifestFromSnapshot(store, relativePath, snapshot);
	if (manifest) {
		if (
			provenanceKey(manifest.provenance) !== expectedKey ||
			manifest.provenance.targetSessionId !== expectedTargetSessionId
		)
			throw new Error("destination_conflict");
	} else if (snapshot.entries.some(entry => entry.relativePath !== "")) {
		throw new Error("destination_conflict");
	}
	store.removeTreeExpected(relativePath, snapshot);
	if (await fs.lstat(absolutePath).catch(() => null)) throw new Error("destination_conflict");
}
async function reconcileImportStaging(store: ManagedSessionDescendantStore, scopeDirectory: string): Promise<void> {
	const stagingRoot = path.join(scopeDirectory, IMPORT_INTERNAL_DIRECTORY, IMPORT_STAGING_DIRECTORY);
	const entries = await fs.readdir(stagingRoot, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("identity_mismatch");
		const relativePath = `${IMPORT_INTERNAL_DIRECTORY}/${IMPORT_STAGING_DIRECTORY}/${entry.name}`;
		const receipt = await readRecoveryReceipt(path.join(stagingRoot, entry.name, IMPORT_RECOVERY_RECEIPT));
		if (receipt) {
			const transcriptPath = path.join(scopeDirectory, `${receipt.artifactDirectory}.jsonl`);
			if (!(await fs.lstat(transcriptPath).catch(() => null)))
				await reconcileStaleArtifactDirectory(
					store,
					scopeDirectory,
					receipt.artifactDirectory,
					transcriptPath,
					receipt.importKey,
					receipt.targetSessionId,
				);
		}
		const snapshot = store.captureTree(relativePath);
		store.removeTreeExpected(relativePath, snapshot);
	}
}

async function reconcileWorkspaceImports(cwd: string): Promise<void> {
	const agentDir = getAgentDir();
	const sessionsRoot = getSessionsDir(agentDir);
	const resolved = resolveManagedScopeForWrite({ cwd, agentDir, sessionsRoot });
	if (resolved.kind === "error") throw new Error(resolved.code);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind === "error") throw new Error(prepared.code);
	const root = managedRootForScope(resolved.scope);
	const store = new ManagedSessionDescendantStore(root, resolved.scope.directoryPath);
	let lock: ManagedStorageLock | undefined;
	try {
		lock = await acquireManagedLock(
			path.join(resolved.scope.directoryPath, IMPORT_INTERNAL_DIRECTORY, IMPORT_LOCKS_DIRECTORY),
			"import-session-global",
			root,
		);
		await reconcileImportStaging(store, resolved.scope.directoryPath);
	} finally {
		if (lock) await lock.release();
		store.close();
	}
}
async function retryCleanupPending<T>(operation: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "cleanup_pending") throw error;
			lastError = error;
		}
	}
	throw lastError;
}

async function stageConversion(
	store: ManagedSessionDescendantStore,
	attemptRelative: string,
	conversionSource: CodexConversion["source"],
): Promise<{ conversion: CodexConversion; transcript: StagedTranscript }> {
	const attemptStore = store.deriveSubtree(attemptRelative);
	const bodyPath = path.join(attemptStore.dir, "body.jsonl");
	const finalPath = path.join(attemptStore.dir, "transcript.jsonl");
	const bodyHandle = await fs.open(bodyPath, "wx", 0o600);
	const bodyWriter = new BufferedFileWriter(bodyHandle);
	const provenanceId = entryId();
	let parentId: string | null = provenanceId;
	const pendingToolNames = new Map<string, string>();
	let conversion: CodexConversion;
	try {
		conversion = await convertCodexSession(conversionSource, async (event: CodexMappedEvent) => {
			let entry: Record<string, unknown>;
			if (event.kind === "user") {
				entry = makeEntry(entryId(), parentId, event.timestamp, {
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: event.text }],
						attribution: "user",
						timestamp: timestampMs(event.timestamp),
					},
				});
			} else if (event.kind === "assistant") {
				entry = makeEntry(entryId(), parentId, event.timestamp, {
					type: "message",
					message: assistantEnvelope([{ type: "text", text: event.text }], event.timestamp, "stop"),
				});
			} else if (event.kind === "tool_call") {
				pendingToolNames.set(event.callId, event.name);
				entry = makeEntry(entryId(), parentId, event.timestamp, {
					type: "message",
					message: assistantEnvelope(
						[{ type: "toolCall", id: event.callId, name: event.name, arguments: event.arguments }],
						event.timestamp,
						"toolUse",
					),
				});
			} else {
				entry = makeEntry(entryId(), parentId, event.timestamp, {
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: event.callId,
						toolName: pendingToolNames.get(event.callId) ?? "codex_tool",
						content: [{ type: "text", text: event.output }],
						isError: false,
						timestamp: timestampMs(event.timestamp),
					},
				});
				pendingToolNames.delete(event.callId);
			}
			parentId = String(entry.id);
			await bodyWriter.line(entry);
		});
		await bodyWriter.flush();
		await bodyHandle.sync();
	} finally {
		await bodyHandle.close();
	}
	const targetSessionId = stableTargetSessionId(importKey(conversion));
	const quarantine = quarantineBytes(conversion);
	const provenance: ImportProvenance = {
		schemaVersion: 1,
		providerId: CODEX_PROVIDER_ID,
		sourceSessionId: conversion.source.id,
		sourceSha256: conversion.sourceSha256,
		converterVersion: CODEX_CONVERTER_VERSION,
		sanitizerVersion: CODEX_SANITIZER_VERSION,
		mappingVersion: CODEX_MAPPING_VERSION,
		targetSessionId,
		sourceBytes: conversion.sourceBytes,
		transcriptBytes: 0,
		counts: conversion.counts,
		quarantine: {
			present: quarantine !== null,
			truncated: conversion.quarantineTruncated,
			...(quarantine ? { sha256: createHash("sha256").update(quarantine).digest("hex") } : {}),
		},
		source: {
			workspaceSha256: createHash("sha256").update(path.resolve(conversion.source.cwd)).digest("hex"),
			...(conversion.source.cliVersion
				? { cliVersion: sanitizeImportedString(conversion.source.cliVersion).value }
				: {}),
			...(conversion.source.modelProvider
				? { modelProvider: sanitizeImportedString(conversion.source.modelProvider).value }
				: {}),
		},
	};
	const timestamp = conversion.source.timestamp;
	const header = {
		type: "session",
		version: 5,
		id: targetSessionId,
		title:
			conversion.source.title ?? sanitizeImportedString(`Imported Codex ${conversion.source.id.slice(0, 12)}`).value,
		titleSource: "user",
		timestamp,
		cwd: conversion.source.cwd,
	};
	const modelId = entryId();
	const model = makeEntry(modelId, null, timestamp, {
		type: "model_change",
		model: "openai-codex/codex-imported-history",
	});
	let prefix = Buffer.alloc(0);
	for (let attempt = 0; attempt < 8; attempt++) {
		const provenanceEntry = makeEntry(provenanceId, modelId, timestamp, {
			type: "custom",
			customType: "session-import-provenance",
			data: provenance,
		});
		prefix = Buffer.from(
			`${JSON.stringify(header)}\n${JSON.stringify(model)}\n${JSON.stringify(provenanceEntry)}\n`,
			"utf8",
		);
		const nextBytes = prefix.byteLength + bodyWriter.bytes;
		if (nextBytes === provenance.transcriptBytes) break;
		provenance.transcriptBytes = nextBytes;
	}
	if (provenance.transcriptBytes > TARGET_TRANSCRIPT_MAX_BYTES)
		throw new CodexImportError(
			"content_too_large",
			"source_event",
			"Converted GJC transcript exceeds the import limit.",
			TARGET_TRANSCRIPT_MAX_BYTES,
			provenance.transcriptBytes,
		);
	const finalHandle = await fs.open(finalPath, "wx", 0o600);
	const finalWriter = new BufferedFileWriter(finalHandle);
	const transcriptHash = createHash("sha256");
	try {
		transcriptHash.update(prefix);
		await finalWriter.write(prefix);
		await streamFileIntoWriter(bodyPath, finalWriter, transcriptHash);
		await finalWriter.flush();
		await finalHandle.sync();
	} finally {
		await finalHandle.close();
	}
	if (finalWriter.bytes !== provenance.transcriptBytes) throw new Error("validation_failed");
	await validateExactV5(finalPath, targetSessionId, finalWriter.bytes);
	return {
		conversion,
		transcript: {
			relativePath: `${attemptRelative}/transcript.jsonl`,
			absolutePath: finalPath,
			bytes: finalWriter.bytes,
			sha256: transcriptHash.digest("hex"),
			provenance,
		},
	};
}

async function publishSource(source: CodexConversion["source"]): Promise<SessionImportSuccess> {
	const agentDir = getAgentDir();
	const sessionsRoot = getSessionsDir(agentDir);
	await assertCodexWorkspaceIdentity(source);
	const resolved = resolveManagedScopeForWrite({ cwd: source.cwd, agentDir, sessionsRoot });
	if (resolved.kind === "error") {
		const cause = resolved.cause?.classification;
		if (resolved.code === "artifact_capacity_exceeded" || cause === "artifact_capacity_exceeded")
			throw new CodexImportError(
				"content_too_large",
				"quarantine",
				"Managed session artifacts exceed the storage limit.",
			);
		throw new Error(resolved.code);
	}
	await assertCodexWorkspaceIdentity(source);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind === "error") {
		const cause = prepared.cause?.classification;
		if (prepared.code === "artifact_capacity_exceeded" || cause === "artifact_capacity_exceeded")
			throw new CodexImportError(
				"content_too_large",
				"quarantine",
				"Managed session artifacts exceed the storage limit.",
			);
		throw new Error(prepared.code);
	}
	const root = managedRootForScope(resolved.scope);
	const store = new ManagedSessionDescendantStore(root, resolved.scope.directoryPath);
	const attemptId = randomUUID();
	const attemptRelative = `${IMPORT_INTERNAL_DIRECTORY}/${IMPORT_STAGING_DIRECTORY}/${attemptId}`;
	let artifactsPublished = false;
	let artifactDirectory = "";
	let cleanupAttempt = true;
	let recoveryLock: ManagedStorageLock | undefined;
	try {
		recoveryLock = await acquireManagedLock(
			path.join(resolved.scope.directoryPath, IMPORT_INTERNAL_DIRECTORY, IMPORT_LOCKS_DIRECTORY),
			"import-session-global",
			root,
		);
		await reconcileImportStaging(store, resolved.scope.directoryPath);
		const staged = await stageConversion(store, attemptRelative, source);
		const key = importKey(staged.conversion);
		const targetSessionId = staged.transcript.provenance.targetSessionId;
		const lockName = `import-${createHash("sha256").update(key).digest("hex")}`;
		const lock = await acquireManagedLock(
			path.join(resolved.scope.directoryPath, IMPORT_INTERNAL_DIRECTORY, IMPORT_LOCKS_DIRECTORY),
			lockName,
			root,
		);
		try {
			const existing = await findExisting(resolved.scope, key);
			if (existing) return existing;
			const timestamp = staged.conversion.source.timestamp.replace(/[:.]/g, "-");
			const filename = `${timestamp}_${targetSessionId}.jsonl`;
			artifactDirectory = filename.slice(0, -6);
			const manifest: ImportManifest = {
				schemaVersion: 1,
				provenance: staged.transcript.provenance,
				transcriptSha256: staged.transcript.sha256,
			};
			await reconcileStaleArtifactDirectory(
				store,
				resolved.scope.directoryPath,
				artifactDirectory,
				path.join(resolved.scope.directoryPath, filename),
				key,
				targetSessionId,
			);
			const recoveryReceipt: ImportRecoveryReceipt = {
				schemaVersion: 1,
				artifactDirectory,
				importKey: key,
				targetSessionId,
			};
			await store.publishNoReplace(
				`${attemptRelative}/${IMPORT_RECOVERY_RECEIPT}`,
				Buffer.from(`${JSON.stringify(recoveryReceipt)}\n`, "utf8"),
			);
			const artifactStagingRelative = `${attemptRelative}/artifacts`;
			const artifactStore = store.deriveSubtree(artifactStagingRelative);
			try {
				await artifactStore.publishNoReplace(
					"codex-import-manifest.json",
					Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
				);
				const quarantine = quarantineBytes(staged.conversion);
				if (quarantine) await artifactStore.publishNoReplace("codex-quarantine.jsonl", quarantine);
				artifactStore.fsyncTree();
			} finally {
				artifactStore.close();
			}
			const artifactSnapshot = store.captureTree(artifactStagingRelative);
			store.moveTreeNoReplace(artifactStagingRelative, artifactDirectory, artifactSnapshot);
			artifactsPublished = true;
			store.publishStagedFileNoReplace(staged.transcript.relativePath, filename, {
				bytes: staged.transcript.bytes,
				sha256: staged.transcript.sha256,
			});
			return {
				status: "imported",
				provider: "codex",
				sourceSessionId: staged.conversion.source.id,
				targetSessionId,
				targetPath: path.join(resolved.scope.directoryPath, filename),
				sourceBytes: staged.conversion.sourceBytes,
				transcriptBytes: staged.transcript.bytes,
				mappedEvents: staged.conversion.counts.mapped,
				quarantinedEvents: staged.conversion.counts.quarantined,
				redactedValues: staged.conversion.counts.redacted,
			};
		} catch (error) {
			const cleanupSafe =
				(!(error instanceof ManagedPublishError) && !(error instanceof ManagedTreeMoveOutcomeError)) ||
				error.stagingCleanupSafe;
			if (!cleanupSafe) cleanupAttempt = false;
			if (cleanupSafe && artifactsPublished && artifactDirectory) await removeStaging(store, artifactDirectory);
			throw error;
		} finally {
			await lock.release();
		}
	} finally {
		if (cleanupAttempt) await removeStaging(store, attemptRelative);
		if (recoveryLock) await recoveryLock.release();
		store.close();
	}
}
async function publishSourceWithRecovery(source: CodexSessionSource): Promise<SessionImportSuccess> {
	return retryCleanupPending(() => publishSource(source));
}

export async function importCodexSessions(
	cwd: string,
	requestedIds: readonly string[],
): Promise<SessionImportBatchResult> {
	let sources: CodexSessionSource[] = [];
	try {
		sources = await discoverCodexSessions(cwd, requestedIds, undefined, true);
		const canonicalWorkspace = sources[0]?.cwd ?? (await fs.realpath(cwd));
		await retryCleanupPending(() => reconcileWorkspaceImports(canonicalWorkspace));
	} catch (error) {
		await closeCodexSessionAuthorities(sources);
		return { provider: "codex", status: "failed", results: [classifyFailure(error)] };
	}
	if (sources.length === 0) {
		return {
			provider: "codex",
			status: "failed",
			results: [
				{
					status: "failed",
					provider: "codex",
					code: "source_not_found",
					phase: "discovery",
					retryable: false,
					message: "No Codex sessions belong to the current workspace.",
				},
			],
		};
	}
	const results: SessionImportResult[] = [];
	for (const source of sources) {
		try {
			results.push(await publishSourceWithRecovery(source));
		} catch (error) {
			results.push(classifyFailure(error, source.id));
		}
	}
	await closeCodexSessionAuthorities(sources);
	const imported = results.filter(result => result.status === "imported").length;
	const existing = results.filter(result => result.status === "existing").length;
	const failed = results.filter(result => result.status === "failed").length;
	return {
		provider: "codex",
		status: failed > 0 ? (imported + existing > 0 ? "partial" : "failed") : imported > 0 ? "success" : "existing",
		results,
	};
}

export function formatSessionImportBatch(result: SessionImportBatchResult): string {
	const lines = result.results.map(item => {
		if (item.status === "failed") {
			const id = item.sourceSessionId ? ` ${item.sourceSessionId}` : "";
			return `failed${id}: ${item.code} (${item.phase}) — ${item.message}`;
		}
		return `${item.status} ${item.sourceSessionId} -> ${item.targetSessionId} (${item.mappedEvents} mapped, ${item.quarantinedEvents} quarantined)`;
	});
	return [`Codex session import: ${result.status}`, ...lines].join("\n");
}
