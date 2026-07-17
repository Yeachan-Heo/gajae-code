import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { SdkStartupFailure, SdkStartupRollbackResult } from "../startup-capability";
import { parseLifecycleJson } from "./lifecycle-codec";
import { assertSupportedStateVersion, SDK_STATE_VERSION } from "./state-version";

export type LifecycleState =
	| "accepted"
	| "effect_started"
	| "awaiting_ready"
	| "terminal_ok"
	| "terminal_error"
	| "terminal_uncertain";
export interface LifecycleWorktreeIntent {
	repoRoot: string;
	worktreePath: string;
	detached: boolean;
	baseRef: string;
	branchName?: string;
}

export interface LifecycleEffectIntent {
	sessionId: string;
	stateRoot: string;
	childOwnershipEstablished?: boolean;
	worktree?: LifecycleWorktreeIntent;
}

/** Durable lifecycle effects retained for exact replay; never implies rollback authority. */
export interface LifecycleCleanupProof {
	processExited: true;
	endpointRemoved: true;
	hostUnregistered:
		| { state: "unregistered"; indexSeq: number; lifecycleRequestId?: string }
		| { state: "not_registered" };
	rollback: {
		endpointGeneration: number | null;
		fenced: true;
		runtimeRemoved: true;
		hostStopped: true;
		brokerRegistrationReleased: true;
	};
}

export interface LifecycleStartupFailureReceipt extends SdkStartupFailure {
	artifactDigest: string;
	rollback: SdkStartupRollbackResult;
	cleanupProof?: LifecycleCleanupProof;
}

export interface LifecycleDurableEffectsReceipt {
	worktree?: {
		cwdDigest: string;
		created: boolean;
		reused: boolean;
		branchDigest?: string;
	};
	transcript?: {
		identityDigest: string;
		contentDigest: string;
	};
	startup?: LifecycleStartupFailureReceipt;
	digest?: string;
}

export interface LifecycleLedgerEntry {
	version: typeof SDK_STATE_VERSION;
	identity: string;
	requestHash: string;
	state: LifecycleState;
	intendedSessionId?: string;
	resultSessionId?: string;
	effectMarker?: string;
	effectIntent?: LifecycleEffectIntent;
	durableEffects?: LifecycleDurableEffectsReceipt;
	startupFailure?: LifecycleStartupFailureReceipt;

	endpointGeneration?: number;
	responseDigest?: string;
	response?: unknown;
	ts: number;
}
export type BeginResult =
	| { kind: "new"; entry: LifecycleLedgerEntry }
	| { kind: "replay"; entry: LifecycleLedgerEntry }
	| { kind: "idempotency_conflict" }
	| { kind: "terminal_uncertain"; entry: LifecycleLedgerEntry }
	| { kind: "in_progress"; entry: LifecycleLedgerEntry };
const terminal = (s: LifecycleState) => s === "terminal_ok" || s === "terminal_error";
const final = (s: LifecycleState) => terminal(s) || s === "terminal_uncertain";
export interface LifecycleLedgerLimits {
	maxBytes?: number;
	maxLineBytes?: number;
	maxRows?: number;
}
const DEFAULT_LIFECYCLE_LEDGER_LIMITS: Required<LifecycleLedgerLimits> = {
	maxBytes: 64 * 1024 * 1024,
	maxLineBytes: 8 * 1024 * 1024,
	maxRows: 10_000,
};
const MAX_LIFECYCLE_LEDGER_JSON_DEPTH = 64;
const MAX_LIFECYCLE_LEDGER_JSON_FIELDS = 1024;

function isBoundedLedgerJson(value: unknown, depth = 0, budget = { fields: 0 }): boolean {
	if (depth > MAX_LIFECYCLE_LEDGER_JSON_DEPTH) return false;
	if (value === null || typeof value !== "object") return true;
	if (Array.isArray(value)) {
		if (value.length > MAX_LIFECYCLE_LEDGER_JSON_FIELDS) return false;
		return value.every(item => isBoundedLedgerJson(item, depth + 1, budget));
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	budget.fields += keys.length;
	return (
		budget.fields <= MAX_LIFECYCLE_LEDGER_JSON_FIELDS &&
		keys.every(key => isBoundedLedgerJson(record[key], depth + 1, budget))
	);
}

function isLifecycleLedgerEntry(value: unknown): value is LifecycleLedgerEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !isBoundedLedgerJson(value)) return false;
	const entry = value as Partial<LifecycleLedgerEntry>;
	return (
		entry.version === SDK_STATE_VERSION &&
		typeof entry.identity === "string" &&
		entry.identity.length > 0 &&
		typeof entry.requestHash === "string" &&
		entry.requestHash.length > 0 &&
		(entry.state === "accepted" ||
			entry.state === "effect_started" ||
			entry.state === "awaiting_ready" ||
			entry.state === "terminal_ok" ||
			entry.state === "terminal_error" ||
			entry.state === "terminal_uncertain") &&
		typeof entry.ts === "number" &&
		Number.isSafeInteger(entry.ts)
	);
}
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function hasValidTerminalDigests(entry: LifecycleLedgerEntry): boolean {
	if (!terminal(entry.state) && entry.state !== "terminal_uncertain") return true;
	if (
		(entry.state !== "terminal_uncertain" || entry.response !== undefined) &&
		(entry.response === undefined ||
			typeof entry.responseDigest !== "string" ||
			entry.responseDigest !== createHash("sha256").update(canonicalJson(entry.response)).digest("hex"))
	)
		return false;
	if (!entry.durableEffects) return true;
	const { digest, ...body } = entry.durableEffects;
	return typeof digest === "string" && digest === createHash("sha256").update(canonicalJson(body)).digest("hex");
}
export class LifecycleLedger {
	#file: string;
	#corruptFile: string;
	#entries: LifecycleLedgerEntry[] = [];
	#byIdentity = new Map<string, LifecycleLedgerEntry>();
	#limits: Required<LifecycleLedgerLimits>;
	#rowCount = 0;
	#byteCount = 0;
	#warnings: string[] = [];
	#mutationTail: Promise<void> = Promise.resolve();

	async #mutate<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#mutationTail;
		const completion = Promise.withResolvers<void>();
		this.#mutationTail = previous.then(() => completion.promise);
		await previous;
		try {
			return await operation();
		} finally {
			completion.resolve();
		}
	}

	constructor(agentDir: string, limits: LifecycleLedgerLimits = {}) {
		this.#file = path.join(agentDir, "sdk", "lifecycle-ledger.jsonl");
		this.#corruptFile = `${this.#file}.corrupt`;
		this.#limits = {
			maxBytes: limits.maxBytes ?? DEFAULT_LIFECYCLE_LEDGER_LIMITS.maxBytes,
			maxLineBytes: limits.maxLineBytes ?? DEFAULT_LIFECYCLE_LEDGER_LIMITS.maxLineBytes,
			maxRows: limits.maxRows ?? DEFAULT_LIFECYCLE_LEDGER_LIMITS.maxRows,
		};
	}
	async open(): Promise<this> {
		return this.#mutate(async () => this.#open());
	}

	async #open(): Promise<this> {
		await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		this.#entries = [];
		this.#byIdentity.clear();
		this.#warnings = [];
		this.#rowCount = 0;
		this.#byteCount = 0;
		const invalidIdentities = new Set<string>();
		const syntheticUncertain = new Map<string, LifecycleLedgerEntry>();
		const uncertainAfterCorruption = new Set<string>();
		const source = await this.#readBoundedSource();
		let tornTail = false;
		if (source) {
			this.#byteCount = source.length;
			tornTail = source.length > 0 && source.at(-1) !== 0x0a;
			let lineStart = 0;
			for (let offset = 0; offset <= source.length; offset += 1) {
				if (offset !== source.length && source[offset] !== 0x0a) continue;
				const line = source.subarray(lineStart, offset);
				lineStart = offset + 1;
				if (line.length === 0) continue;
				this.#rowCount += 1;
				if (this.#rowCount > this.#limits.maxRows)
					await this.#rejectOversizedSource("Lifecycle ledger exceeds the maximum row count.");
				if (line.length > this.#limits.maxLineBytes)
					await this.#rejectOversizedSource("Lifecycle ledger row exceeds the maximum byte length.");
				try {
					const value = parseLifecycleJson(line);
					assertSupportedStateVersion(this.#file, value);
					if (!isLifecycleLedgerEntry(value)) throw new Error("invalid ledger entry");
					const entry = value;
					const prior = this.#byIdentity.get(entry.identity);
					const invalidHistory =
						invalidIdentities.has(entry.identity) ||
						uncertainAfterCorruption.has(entry.identity) ||
						!hasValidTerminalDigests(entry) ||
						!this.#isValidHistoryContinuation(prior, entry);
					if (invalidHistory) {
						await this.#quarantine(line);
						invalidIdentities.add(entry.identity);
						if (!syntheticUncertain.has(entry.identity))
							syntheticUncertain.set(entry.identity, this.#uncertainFrom(prior ?? entry, prior !== undefined));
						continue;
					}
					this.#entries.push(entry);
					this.#byIdentity.set(entry.identity, entry);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "unsupported_state_version") throw error;
					for (const [identity, latest] of this.#byIdentity) {
						if (!final(latest.state)) uncertainAfterCorruption.add(identity);
					}
					await this.#quarantine(line);
				}
			}
		}
		if (tornTail) await this.#sealTornTail();
		for (const [identity, uncertain] of syntheticUncertain) {
			this.#byIdentity.set(identity, uncertain);
			if (this.#entries.some(entry => entry.identity === identity && entry.state === "accepted"))
				await this.#append(uncertain);
		}
		for (const identity of uncertainAfterCorruption) {
			const entry = this.#byIdentity.get(identity);
			if (entry && !final(entry.state)) await this.#append(this.#uncertainFrom(entry));
		}
		// Effects may have completed after the last durable marker; do not retry them after a restart.
		for (const entry of [...this.#byIdentity.values()]) {
			if ((entry.state === "effect_started" && !this.#isCleanupPending(entry)) || entry.state === "awaiting_ready")
				await this.#append(this.#uncertainFrom(entry));
		}
		return this;
	}
	/**
	 * Reads terminal proof for one request without recovering or changing the ledger.
	 *
	 * This intentionally accepts an unrelated unterminated final write: concurrent
	 * appenders may have started a different row after this request's synced terminal
	 * row. Complete rows are still decoded and validated strictly, and any incomplete
	 * tail that identifies this request withholds proof.
	 */
	async readTerminal(identity: string, requestHash: string): Promise<LifecycleLedgerEntry | undefined> {
		const source = await this.#readBoundedSourceReadOnly();
		if (!source) return undefined;
		let prior: LifecycleLedgerEntry | undefined;
		let latest: LifecycleLedgerEntry | undefined;
		let rows = 0;
		let lineStart = 0;
		const finalNewline = source.length > 0 && source.at(-1) === 0x0a;
		const completeLength = finalNewline ? source.length : source.lastIndexOf(0x0a) + 1;
		for (let offset = 0; offset < completeLength; offset += 1) {
			if (source[offset] !== 0x0a) continue;
			const line = source.subarray(lineStart, offset);
			lineStart = offset + 1;
			if (line.length === 0) continue;
			rows += 1;
			if (rows > this.#limits.maxRows || line.length > this.#limits.maxLineBytes) return undefined;
			let entry: LifecycleLedgerEntry;
			try {
				const value = parseLifecycleJson(line);
				assertSupportedStateVersion(this.#file, value);
				if (!isLifecycleLedgerEntry(value)) return undefined;
				entry = value;
			} catch {
				return undefined;
			}
			if (entry.identity !== identity) continue;
			if (
				entry.requestHash !== requestHash ||
				!hasValidTerminalDigests(entry) ||
				!this.#isValidHistoryContinuation(prior, entry)
			)
				return undefined;
			prior = entry;
			latest = entry;
		}
		if (!finalNewline) {
			const tail = source.subarray(completeLength);
			// LifecycleLedger writes JSON.stringify entries, so this marker is exact for
			// a partially persisted row from this identity without inspecting arbitrary
			// malformed data as a valid record.
			const identityMarker = Buffer.from(`"identity":${JSON.stringify(identity)}`);
			if (tail.includes(identityMarker)) return undefined;
		}
		return latest && terminal(latest.state) ? latest : undefined;
	}

	#isValidHistoryContinuation(previous: LifecycleLedgerEntry | undefined, next: LifecycleLedgerEntry): boolean {
		if (!previous) return next.state === "accepted";
		if (previous.requestHash !== next.requestHash || final(previous.state)) return false;
		if (previous.state === "accepted") return true;
		return next.state === "effect_started" || next.state === "awaiting_ready" || final(next.state);
	}
	#isCleanupPending(entry: LifecycleLedgerEntry): boolean {
		if (!entry.response || typeof entry.response !== "object") return false;
		const response = entry.response as { ok?: unknown; error?: { code?: unknown; cleanup?: unknown } };
		return (
			response.ok === false && response.error?.code === "cleanup_pending" && response.error.cleanup !== undefined
		);
	}

	#uncertainFrom(entry: LifecycleLedgerEntry, trusted = true): LifecycleLedgerEntry {
		if (trusted) return { ...entry, state: "terminal_uncertain", ts: Date.now() };
		return {
			version: SDK_STATE_VERSION,
			identity: entry.identity,
			requestHash: entry.requestHash,
			state: "terminal_uncertain",
			ts: Date.now(),
		};
	}
	async #readBoundedSource(): Promise<Buffer | undefined> {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(this.#file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
			const stat = await handle.stat({ bigint: true });
			if (!stat.isFile() || stat.size > BigInt(this.#limits.maxBytes))
				await this.#rejectOversizedSource("Lifecycle ledger exceeds the maximum file byte length.");
			const bytes = Buffer.alloc(Number(stat.size) + 1);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
			if (bytesRead > this.#limits.maxBytes)
				await this.#rejectOversizedSource("Lifecycle ledger exceeds the maximum file byte length.");
			return bytes.subarray(0, bytesRead);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		} finally {
			if (handle) await handle.close();
		}
	}
	async #readBoundedSourceReadOnly(): Promise<Buffer | undefined> {
		let handle: fs.FileHandle | undefined;
		try {
			handle = await fs.open(this.#file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
			const stat = await handle.stat({ bigint: true });
			if (!stat.isFile() || stat.size > BigInt(this.#limits.maxBytes)) return undefined;
			const bytes = Buffer.alloc(Number(stat.size) + 1);
			const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
			if (bytesRead > this.#limits.maxBytes) return undefined;
			return bytes.subarray(0, bytesRead);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			return undefined;
		} finally {
			if (handle) await handle.close();
		}
	}
	async #rejectOversizedSource(reason: string): Promise<never> {
		await this.#quarantine(reason);
		throw new Error(reason);
	}
	async #openAppendRegular(file: string): Promise<fs.FileHandle> {
		const handle = await fs.open(
			file,
			fsSync.constants.O_WRONLY | fsSync.constants.O_APPEND | fsSync.constants.O_CREAT | fsSync.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			if (!(await handle.stat()).isFile()) throw new Error("Lifecycle ledger write target is not a regular file.");
			return handle;
		} catch (error) {
			await handle.close();
			throw error;
		}
	}
	async #sealTornTail(): Promise<void> {
		const h = await this.#openAppendRegular(this.#file);
		try {
			await h.writeFile("\n");
			await h.sync();
			this.#byteCount += 1;
		} finally {
			await h.close();
		}
	}
	async #quarantine(line: string | Uint8Array): Promise<void> {
		const h = await this.#openAppendRegular(this.#corruptFile);
		try {
			await h.writeFile(line);
			await h.writeFile("\n");
			await h.sync();
		} finally {
			await h.close();
		}
		this.#warnings.push("Malformed lifecycle ledger entry quarantined");
	}
	async #syncDirectory(): Promise<void> {
		const directory = await fs.open(path.dirname(this.#file), fsSync.constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
	async #compact(replacement?: LifecycleLedgerEntry): Promise<boolean> {
		const anchors = new Map<string, LifecycleLedgerEntry>();
		for (const entry of this.#entries) {
			const latest = replacement?.identity === entry.identity ? replacement : this.#byIdentity.get(entry.identity);
			if (entry.state === "accepted" && !anchors.has(entry.identity) && entry.requestHash === latest?.requestHash)
				anchors.set(entry.identity, entry);
		}
		const snapshot: LifecycleLedgerEntry[] = [];
		const compacted = new Map(this.#byIdentity);
		if (replacement) compacted.set(replacement.identity, replacement);
		for (const [identity, latest] of compacted) {
			const anchor = anchors.get(identity);
			if (!anchor) throw new Error("Lifecycle ledger compaction requires an accepted identity anchor.");
			snapshot.push(anchor);
			if (latest.state !== "accepted") snapshot.push(latest);
		}
		const contents = Buffer.from(snapshot.map(entry => `${JSON.stringify(entry)}\n`).join(""));
		if (
			snapshot.length > this.#limits.maxRows ||
			contents.length > this.#limits.maxBytes ||
			snapshot.some(entry => Buffer.byteLength(JSON.stringify(entry)) > this.#limits.maxLineBytes)
		)
			throw new Error("Lifecycle ledger compaction exceeds configured bounds.");
		const temporary = path.join(
			path.dirname(this.#file),
			`.lifecycle-ledger.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
		);
		let renamed = false;
		try {
			const h = await fs.open(
				temporary,
				fsSync.constants.O_WRONLY |
					fsSync.constants.O_CREAT |
					fsSync.constants.O_EXCL |
					fsSync.constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await h.writeFile(contents);
				await h.sync();
			} finally {
				await h.close();
			}
			await fs.rename(temporary, this.#file);
			renamed = true;
			await this.#syncDirectory();
			this.#entries = snapshot;
			this.#byIdentity = compacted;
			this.#rowCount = snapshot.length;
			this.#byteCount = contents.length;
		} finally {
			if (!renamed) await fs.unlink(temporary).catch(() => {});
		}
		return replacement !== undefined;
	}
	get warnings(): readonly string[] {
		return this.#warnings;
	}
	async #append(entry: LifecycleLedgerEntry): Promise<LifecycleLedgerEntry> {
		const line = Buffer.from(`${JSON.stringify(entry)}\n`);
		if (line.length - 1 > this.#limits.maxLineBytes)
			throw new Error("Lifecycle ledger row exceeds the maximum byte length.");
		let replacementCompacted = false;
		if (this.#rowCount + 1 > this.#limits.maxRows || this.#byteCount + line.length > this.#limits.maxBytes)
			replacementCompacted = await this.#compact(this.#byIdentity.has(entry.identity) ? entry : undefined);
		if (replacementCompacted) return entry;
		if (this.#rowCount + 1 > this.#limits.maxRows || this.#byteCount + line.length > this.#limits.maxBytes)
			throw new Error("Lifecycle ledger append exceeds configured bounds.");
		const h = await this.#openAppendRegular(this.#file);
		try {
			await h.writeFile(line);
			await h.sync();
		} finally {
			await h.close();
		}
		this.#entries.push(entry);
		this.#byIdentity.set(entry.identity, entry);
		this.#rowCount += 1;
		this.#byteCount += line.length;
		return entry;
	}
	async begin(identity: string, requestHash: string): Promise<BeginResult> {
		return this.#mutate(async () => this.#begin(identity, requestHash));
	}

	async #begin(identity: string, requestHash: string): Promise<BeginResult> {
		const prior = this.#byIdentity.get(identity);
		if (!prior)
			return {
				kind: "new",
				entry: await this.#append({
					version: SDK_STATE_VERSION,
					identity,
					requestHash,
					state: "accepted",
					ts: Date.now(),
				}),
			};
		if (prior.requestHash !== requestHash) return { kind: "idempotency_conflict" };
		if (terminal(prior.state) || (prior.state === "effect_started" && this.#isCleanupPending(prior)))
			return { kind: "replay", entry: prior };
		if (prior.state === "terminal_uncertain") return { kind: "terminal_uncertain", entry: prior };
		// An accepted row has no durable side effect. Target serialization makes retrying it safe.
		if (prior.state === "accepted") return { kind: "new", entry: prior };
		return { kind: "in_progress", entry: prior };
	}
	async transition(
		identity: string,
		state: LifecycleState,
		fields: Omit<Partial<LifecycleLedgerEntry>, "identity" | "requestHash" | "state" | "ts"> = {},
	): Promise<LifecycleLedgerEntry> {
		return this.#mutate(async () => {
			const previous = this.#byIdentity.get(identity);
			if (!previous) throw new Error("Unknown lifecycle identity");
			const next = { ...previous, ...fields, state, ts: Date.now() };
			if (
				(terminal(state) || state === "terminal_uncertain") &&
				next.response !== undefined &&
				next.responseDigest === undefined
			)
				next.responseDigest = createHash("sha256").update(canonicalJson(next.response)).digest("hex");
			if (next.durableEffects && next.durableEffects.digest === undefined) {
				const { digest: _digest, ...body } = next.durableEffects;
				next.durableEffects = {
					...body,
					digest: createHash("sha256").update(canonicalJson(body)).digest("hex"),
				};
			}
			return this.#append(next);
		});
	}
	async assertSupportedStateVersions(): Promise<void> {
		const source = await this.#readBoundedSource();
		if (!source) return;
		let lineStart = 0;
		for (let offset = 0; offset <= source.length; offset += 1) {
			if (offset !== source.length && source[offset] !== 0x0a) continue;
			const line = source.subarray(lineStart, offset);
			lineStart = offset + 1;
			if (line.length === 0 || line.length > this.#limits.maxLineBytes) continue;
			try {
				assertSupportedStateVersion(this.#file, parseLifecycleJson(line));
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "unsupported_state_version") throw error;
			}
		}
	}
	get(identity: string): LifecycleLedgerEntry | undefined {
		return this.#byIdentity.get(identity);
	}
}
