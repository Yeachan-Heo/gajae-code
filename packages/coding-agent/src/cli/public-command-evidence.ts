import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const EVIDENCE_LIMITS = Object.freeze({
	slots: 64,
	recordBytes: 1_048_576,
	totalBytes: 16_777_216,
	ttlMs: 86_400_000,
	fragmentBytes: 1024,
	responseBytes: 8192,
});
export type EvidenceReferenceKind =
	| "sessionId"
	| "operationRef"
	| "idempotencyKey"
	| "claimId"
	| "commandId"
	| "turnId";
export interface EvidenceReference {
	kind: EvidenceReferenceKind;
	value: string;
}
export interface EvidenceClassification {
	code: string;
	category: "usage" | "unavailable" | "authorization" | "timeout" | "uncertain" | "operation" | "internal";
	retryability: "yes" | "no" | "unknown";
	outcomeCertainty: "not-applied" | "applied" | "unknown";
}
export type EvidenceUnavailableReason =
	| "record_too_large"
	| "quota_exceeded"
	| "store_busy"
	| "permission_denied"
	| "permission_unsupported"
	| "unsafe_path"
	| "store_corrupt"
	| "io_error"
	| "verification_failed"
	| "locator_too_large"
	| "evidence_unavailable"
	| "evidence_changed"
	| "evidence_corrupt"
	| "evidence_unsafe"
	| "evidence_clock_invalid"
	| "invalid_request";
export interface EvidenceUnavailable {
	status: "unavailable";
	reason: EvidenceUnavailableReason;
	requiredBytes: number | null;
	continuation: null;
}
export interface EvidenceContinuation {
	kind: "local-store";
	id: string;
	sha256: string;
	expiresAt: string;
	page: number;
	executable: "gjc";
	argv: string[];
}
export interface EvidenceLocatorOptions {
	family: "sdk" | "daemon";
	scopeAgentDir?: string;
	json?: boolean;
}
export interface PublishCommandEvidenceInput {
	agentDir: string;
	command: string[];
	error: EvidenceClassification;
	references: readonly EvidenceReference[];
}
export interface EvidenceRetained {
	status: "retained";
	id: string;
	sha256: string;
	bytes: number;
	expiresAt: string;
	continuation: EvidenceContinuation;
}
export interface EvidenceRecord {
	schema: "gjc.command-error-record";
	version: 1;
	pagingVersion: 1;
	id: string;
	command: string[];
	error: EvidenceClassification;
	createdAt: string;
	expiresAt: string;
	references: EvidenceReference[];
}
export interface EvidencePage {
	schema: "gjc.command-error-evidence";
	version: 1;
	ok: true;
	id: string;
	sha256: string;
	expiresAt: string;
	page: number;
	complete: boolean;
	fragments: { entryId: string; encoding: "base64"; offsetBytes: number; totalBytes: number; data: string }[];
	next: EvidenceContinuation | null;
}
export interface ReadCommandEvidenceInput extends EvidenceLocatorOptions {
	agentDir: string;
	id: string;
	sha256: string;
	page?: number;
}

type Handle = fs.FileHandle;
const kinds = new Set<string>(["sessionId", "operationRef", "idempotencyKey", "claimId", "commandId", "turnId"]);
const slots = Array.from({ length: EVIDENCE_LIMITS.slots }, (_, n) => `${String(n).padStart(2, "0")}.json`);
const idPattern = /^[a-f0-9]{32}$/;
const hashPattern = /^[a-f0-9]{64}$/;
class Failure extends Error {
	constructor(readonly reason: EvidenceUnavailableReason) {
		super(reason);
	}
}
function fail(reason: EvidenceUnavailableReason): never {
	throw new Failure(reason);
}
function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException)?.code;
}
function unavailable(error: unknown, requiredBytes: number | null = null): EvidenceUnavailable {
	const reason =
		error instanceof Failure
			? error.reason
			: code(error) === "EACCES" || code(error) === "EPERM"
				? "permission_denied"
				: code(error) === "ELOOP" || code(error) === "ENOTDIR"
					? "unsafe_path"
					: "io_error";
	return { status: "unavailable", reason, requiredBytes, continuation: null };
}
function identity(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
function fileProof(stat: Stats, limit: number): void {
	if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1)
		fail("unsafe_path");
	if (stat.size > limit || stat.size < 0) fail("store_corrupt");
}

// Each ancestor is protected against replacement by other users before a child
// is opened. A root-owned sticky directory protects a current-user-owned child.
// Same-user compromise is outside this permission boundary. No realpath fallback.
async function openStore(
	agentDir: string,
	create: boolean,
): Promise<{ root: string; verify(): Promise<void>; close(): Promise<void>; directory: Handle }> {
	if (process.platform === "win32" || !process.getuid || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
		fail("permission_unsupported");
	const root = path.join(path.resolve(agentDir), "cli-error-evidence-v1");
	const handles: { name: string; handle: Handle; stat: Stats }[] = [];
	try {
		const components = root.split(path.sep).filter(Boolean);
		let current = path.parse(root).root;
		let stickyParent = false;
		for (let i = -1; i < components.length; i++) {
			if (i >= 0) current = path.join(current, components[i]!);
			if (i === components.length - 1 && create) {
				try {
					await fs.mkdir(current, { mode: 0o700 });
				} catch (error) {
					if (code(error) !== "EEXIST") throw error;
				}
			}
			const handle = await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			const stat = await handle.stat();
			handles.push({ name: current, handle, stat });
			if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid())) fail("unsafe_path");
			if (stickyParent && stat.uid !== process.getuid()) fail("unsafe_path");
			const writable = (stat.mode & 0o022) !== 0;
			const sticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
			if (writable && !sticky) fail("unsafe_path");
			stickyParent = writable;
			if (i === components.length - 1 && (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700))
				fail("unsafe_path");
		}
		const verify = async () => {
			for (const item of handles) {
				const live = await fs.lstat(item.name);
				const opened = await item.handle.stat();
				if (
					!identity(live, item.stat) ||
					!identity(opened, item.stat) ||
					live.mode !== item.stat.mode ||
					live.uid !== item.stat.uid ||
					!live.isDirectory()
				)
					fail("unsafe_path");
			}
		};
		await verify();
		return {
			root,
			verify,
			directory: handles[handles.length - 1]!.handle,
			close: async () => {
				await Promise.all(handles.map(item => item.handle.close()));
			},
		};
	} catch (error) {
		await Promise.all(handles.map(item => item.handle.close().catch(() => {})));
		throw error;
	}
}

type Store = Awaited<ReturnType<typeof openStore>>;
async function readFile(
	store: Store,
	name: string,
	limit: number = EVIDENCE_LIMITS.recordBytes,
): Promise<{ bytes: Buffer; stat: Stats } | null> {
	await store.verify();
	let handle: Handle;
	try {
		handle = await fs.open(
			path.join(store.root, name),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (code(error) === "ENOENT") return null;
		throw error;
	}
	try {
		const before = await handle.stat();
		fileProof(before, limit);
		const bytes = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) fail("verification_failed");
			offset += bytesRead;
		}
		const after = await handle.stat();
		fileProof(after, limit);
		const named = await fs.lstat(path.join(store.root, name));
		if (
			!identity(before, after) ||
			!identity(after, named) ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			fail("verification_failed");
		fileProof(named, limit);
		await store.verify();
		return { bytes, stat: after };
	} finally {
		await handle.close();
	}
}

function validClassification(error: EvidenceClassification): boolean {
	return (
		!!error &&
		typeof error.code === "string" &&
		/^[a-z][a-z0-9_]{0,95}$/.test(error.code) &&
		["usage", "unavailable", "authorization", "timeout", "uncertain", "operation", "internal"].includes(
			error.category,
		) &&
		["yes", "no", "unknown"].includes(error.retryability) &&
		["not-applied", "applied", "unknown"].includes(error.outcomeCertainty)
	);
}
function validCommand(command: string[]): boolean {
	return (
		Array.isArray(command) &&
		command.length > 0 &&
		command.length <= 5 &&
		["sdk", "daemon"].includes(command[0]!) &&
		command.every(token => typeof token === "string" && /^[a-z][a-z-]{0,31}$/.test(token))
	);
}
function recordFromBytes(bytes: Buffer): EvidenceRecord {
	let value: EvidenceRecord;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		return fail("store_corrupt");
	}
	if (
		value?.schema !== "gjc.command-error-record" ||
		value.version !== 1 ||
		value.pagingVersion !== 1 ||
		!idPattern.test(value.id) ||
		!validCommand(value.command) ||
		!validClassification(value.error) ||
		!Array.isArray(value.references) ||
		!value.references.every(
			ref => ref && kinds.has(ref.kind) && typeof ref.value === "string" && Object.keys(ref).length === 2,
		)
	)
		fail("store_corrupt");
	const created = Date.parse(value.createdAt);
	const expires = Date.parse(value.expiresAt);
	if (
		!Number.isFinite(created) ||
		!Number.isFinite(expires) ||
		expires - created !== EVIDENCE_LIMITS.ttlMs ||
		new Date(created).toISOString() !== value.createdAt ||
		new Date(expires).toISOString() !== value.expiresAt
	)
		fail("store_corrupt");
	if (created > Date.now()) fail("evidence_clock_invalid");
	const canonical = serializeRecord(value);
	if (!canonical.equals(bytes)) fail("store_corrupt");
	return value;
}

// Count JSON-escaped UTF-8 bytes without allocating a copy of an oversized value.
function stringBytes(value: string): number {
	let size = 2;
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) size += 2;
		else if (c < 32) size += 6;
		else if (c < 128) size++;
		else if (c < 2048) size += 2;
		else if (
			c >= 0xd800 &&
			c <= 0xdbff &&
			i + 1 < value.length &&
			value.charCodeAt(i + 1) >= 0xdc00 &&
			value.charCodeAt(i + 1) <= 0xdfff
		) {
			size += 4;
			i++;
		} else if (c >= 0xd800 && c <= 0xdfff) size += 6;
		else size += 3;
		if (size > EVIDENCE_LIMITS.recordBytes) fail("record_too_large");
	}
	return size;
}
function serializeRecord(record: EvidenceRecord): Buffer {
	if (!validCommand(record.command) || !validClassification(record.error)) fail("invalid_request");
	let referenceSize = 2;
	for (const ref of record.references) {
		if (!ref || !kinds.has(ref.kind) || typeof ref.value !== "string") fail("invalid_request");
		referenceSize += (referenceSize === 2 ? 0 : 1) + 18 + stringBytes(ref.kind) + stringBytes(ref.value);
		if (referenceSize > EVIDENCE_LIMITS.recordBytes) fail("record_too_large");
	}
	// Only explicitly selected fields are serialized, never caller objects or details.
	const safe = {
		schema: record.schema,
		version: record.version,
		pagingVersion: record.pagingVersion,
		id: record.id,
		command: record.command,
		error: {
			code: record.error.code,
			category: record.error.category,
			retryability: record.error.retryability,
			outcomeCertainty: record.error.outcomeCertainty,
		},
		createdAt: record.createdAt,
		expiresAt: record.expiresAt,
		references: [] as EvidenceReference[],
	};
	if (Buffer.byteLength(JSON.stringify(safe)) - 2 + referenceSize + 1 > EVIDENCE_LIMITS.recordBytes)
		fail("record_too_large");
	safe.references = record.references.map(ref => ({ kind: ref.kind, value: ref.value }));
	const bytes = Buffer.from(`${JSON.stringify(safe)}\n`);
	if (bytes.length > EVIDENCE_LIMITS.recordBytes) fail("record_too_large");
	return bytes;
}
function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function continuation(
	record: EvidenceRecord,
	sha256: string,
	page: number,
	options: EvidenceLocatorOptions,
): EvidenceContinuation {
	if (
		options.scopeAgentDir !== undefined &&
		(options.scopeAgentDir.length > EVIDENCE_LIMITS.responseBytes || options.scopeAgentDir.includes("\0"))
	)
		fail("locator_too_large");
	const argv = [options.family, "--error-ref", record.id, "--error-sha256", sha256, "--error-page", String(page)];
	if (options.scopeAgentDir !== undefined) argv.push(`--error-agent-dir=${options.scopeAgentDir}`);
	if (options.json) argv.push("--json");
	return { kind: "local-store", id: record.id, sha256, expiresAt: record.expiresAt, page, executable: "gjc", argv };
}
function pageFor(
	record: EvidenceRecord,
	bytes: Buffer,
	sha256: string,
	page: number,
	options: EvidenceLocatorOptions,
): EvidencePage {
	const offset = (page - 1) * EVIDENCE_LIMITS.fragmentBytes;
	if (!Number.isSafeInteger(page) || page < 1 || offset >= bytes.length) fail("invalid_request");
	const end = Math.min(offset + EVIDENCE_LIMITS.fragmentBytes, bytes.length);
	const result: EvidencePage = {
		schema: "gjc.command-error-evidence",
		version: 1,
		ok: true,
		id: record.id,
		sha256,
		expiresAt: record.expiresAt,
		page,
		complete: end === bytes.length,
		fragments: [
			{
				entryId: "record",
				encoding: "base64",
				offsetBytes: offset,
				totalBytes: bytes.length,
				data: bytes.subarray(offset, end).toString("base64"),
			},
		],
		next: end === bytes.length ? null : continuation(record, sha256, page + 1, options),
	};
	if (Buffer.byteLength(`${JSON.stringify(result)}\n`) > EVIDENCE_LIMITS.responseBytes) fail("locator_too_large");
	return result;
}
async function removeOwned(store: Store, name: string, stat: Stats): Promise<void> {
	await store.verify();
	const current = await fs.lstat(path.join(store.root, name));
	if (!identity(current, stat)) fail("unsafe_path");
	await fs.unlink(path.join(store.root, name));
}
async function checkLayout(store: Store): Promise<void> {
	const directory = await fs.opendir(store.root);
	let count = 0;
	for await (const entry of directory) {
		if (++count > 66 || (!slots.includes(entry.name) && entry.name !== "pending" && entry.name !== "lock"))
			fail("store_corrupt");
	}
}

/** Narrow per-call fault instrumentation; production callers omit this argument. */
export interface EvidencePublicationTestHooks {
	id?: string;
	before?: (phase: "write" | "file-sync" | "link" | "directory-sync" | "readback" | "cleanup") => void | Promise<void>;
}

export async function publishCommandEvidence(
	input: PublishCommandEvidenceInput,
	options: EvidenceLocatorOptions,
	testHooks?: EvidencePublicationTestHooks,
): Promise<EvidenceRetained | EvidenceUnavailable> {
	let store: Store | undefined;
	let lock: Handle | undefined;
	let lockStat: Stats | undefined;
	let result: EvidenceRetained | EvidenceUnavailable;
	let requiredBytes: number | null = null;
	try {
		if (!validCommand(input.command) || input.command[0] !== options.family) fail("invalid_request");
		const now = Date.now();
		const record: EvidenceRecord = {
			schema: "gjc.command-error-record",
			version: 1,
			pagingVersion: 1,
			id: testHooks?.id ?? randomBytes(16).toString("hex"),
			command: input.command,
			error: input.error,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + EVIDENCE_LIMITS.ttlMs).toISOString(),
			references: input.references as EvidenceReference[],
		};
		if (!idPattern.test(record.id)) fail("invalid_request");
		const bytes = serializeRecord(record);
		requiredBytes = bytes.length;
		const sha256 = digest(bytes);
		const locator = continuation(record, sha256, 1, options);
		if (Buffer.byteLength(JSON.stringify(locator)) > 4096) fail("locator_too_large");
		pageFor(record, bytes, sha256, Math.max(1, Math.ceil(bytes.length / 1024) - 1), options);
		store = await openStore(input.agentDir, true);
		try {
			lock = await fs.open(
				path.join(store.root, "lock"),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
		} catch (error) {
			if (code(error) === "EEXIST") fail("store_busy");
			throw error;
		}
		lockStat = await lock.stat();
		fileProof(lockStat, 4096);
		await checkLayout(store);
		const pending = await readFile(store, "pending");
		if (pending) await removeOwned(store, "pending", pending.stat);
		let total = 0;
		let empty: string | undefined;
		for (const name of slots) {
			const existing = await readFile(store, name);
			if (!existing) {
				empty ??= name;
				continue;
			}
			const old = recordFromBytes(existing.bytes);
			if (old.id === record.id) fail("verification_failed");
			if (Date.parse(old.expiresAt) <= now) {
				await removeOwned(store, name, existing.stat);
				empty ??= name;
			} else total += existing.bytes.length;
		}
		if (!empty || total + bytes.length > EVIDENCE_LIMITS.totalBytes) fail("quota_exceeded");
		await store.verify();
		const pendingHandle = await fs.open(
			path.join(store.root, "pending"),
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		let pendingStat: Stats;
		try {
			fileProof(await pendingHandle.stat(), EVIDENCE_LIMITS.recordBytes);
			await testHooks?.before?.("write");
			await pendingHandle.writeFile(bytes);
			await testHooks?.before?.("file-sync");
			await pendingHandle.sync();
			pendingStat = await pendingHandle.stat();
			fileProof(pendingStat, EVIDENCE_LIMITS.recordBytes);
		} finally {
			await pendingHandle.close();
		}
		await store.verify();
		if (!identity(await fs.lstat(path.join(store.root, "pending")), pendingStat)) fail("verification_failed");
		// link is atomic and never replaces an occupied slot; rename is not safe here.
		await testHooks?.before?.("link");
		await fs.link(path.join(store.root, "pending"), path.join(store.root, empty));
		await removeOwned(store, "pending", pendingStat);
		await testHooks?.before?.("directory-sync");
		await store.directory.sync();
		await testHooks?.before?.("readback");
		const verified = await readFile(store, empty);
		if (
			!verified ||
			!identity(verified.stat, pendingStat) ||
			!verified.bytes.equals(bytes) ||
			digest(verified.bytes) !== sha256
		)
			fail("verification_failed");
		recordFromBytes(verified.bytes);
		result = {
			status: "retained",
			id: record.id,
			sha256,
			bytes: bytes.length,
			expiresAt: record.expiresAt,
			continuation: locator,
		};
	} catch (error) {
		result = unavailable(error, requiredBytes);
	} finally {
		if (store && lock && lockStat) {
			try {
				await testHooks?.before?.("cleanup");
				await removeOwned(store, "lock", lockStat);
			} catch (error) {
				result = unavailable(error, requiredBytes);
			}
		}
		try {
			await lock?.close();
			await store?.close();
		} catch (error) {
			result = unavailable(error, requiredBytes);
		}
	}
	return result!;
}

export async function readCommandEvidence(
	input: ReadCommandEvidenceInput,
): Promise<{ status: "available"; page: EvidencePage } | EvidenceUnavailable> {
	let store: Store | undefined;
	let result: { status: "available"; page: EvidencePage } | EvidenceUnavailable;
	try {
		const page = input.page ?? 1;
		if (
			!idPattern.test(input.id) ||
			!hashPattern.test(input.sha256) ||
			!["sdk", "daemon"].includes(input.family) ||
			!Number.isSafeInteger(page) ||
			page < 1 ||
			page > 1024
		)
			fail("invalid_request");
		try {
			store = await openStore(input.agentDir, false);
		} catch (error) {
			if (code(error) === "ENOENT") fail("evidence_unavailable");
			throw error;
		}
		await checkLayout(store);
		await readFile(store, "lock", 4096);
		await readFile(store, "pending");
		let match: { record: EvidenceRecord; bytes: Buffer } | undefined;
		let total = 0;
		for (const name of slots) {
			const existing = await readFile(store, name);
			if (!existing) continue;
			total += existing.bytes.length;
			if (total > EVIDENCE_LIMITS.totalBytes) fail("store_corrupt");
			const record = recordFromBytes(existing.bytes);
			if (record.id !== input.id) continue;
			if (match) fail("store_corrupt");
			if (record.command[0] !== input.family || Date.parse(record.expiresAt) <= Date.now())
				fail("evidence_unavailable");
			if (digest(existing.bytes) !== input.sha256) fail("evidence_changed");
			match = { record, bytes: existing.bytes };
		}
		if (!match) fail("evidence_unavailable");
		if (Date.parse(match.record.createdAt) > Date.now()) fail("evidence_clock_invalid");
		if (Date.parse(match.record.expiresAt) <= Date.now()) fail("evidence_unavailable");
		await store.verify();
		result = { status: "available", page: pageFor(match.record, match.bytes, input.sha256, page, input) };
	} catch (error) {
		result = unavailable(error);
		if (result.reason === "unsafe_path") result.reason = "evidence_unsafe";
		if (result.reason === "store_corrupt") result.reason = "evidence_corrupt";
		if (result.reason === "verification_failed") result.reason = "evidence_changed";
	} finally {
		try {
			await store?.close();
		} catch (error) {
			result = unavailable(error);
		}
	}
	return result!;
}
