import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const ATTENTION_EVENT_SCHEMA_VERSION = 1;
export const MAX_ATTENTION_TERMINAL_HISTORY = 100;
export const MAX_ATTENTION_IDENTITIES = 500;

export type AttentionEventStatus = "running" | "waiting" | "done" | "failed" | "cancelled";
export type AttentionStoreStatus =
	| "ready"
	| "memory_only"
	| "corrupt"
	| "invalid_path"
	| "unavailable"
	| "write_failed"
	| "overflow";

export interface AttentionEventIdentity {
	readonly kind: string;
	readonly sourceId: string;
	readonly generation: string;
}

export interface AttentionEventAcknowledgement extends AttentionEventIdentity {
	readonly revision: number;
}

export interface AttentionObservation extends AttentionEventIdentity {
	readonly label: string;
	readonly status: AttentionEventStatus;
	readonly startedAt: number;
	readonly observedAt?: number;
}

export interface AttentionEvent extends AttentionEventIdentity {
	readonly label: string;
	readonly status: AttentionEventStatus;
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly revision: number;
	readonly acknowledgedRevision?: number;
}

export interface AttentionStoreSnapshot {
	readonly schemaVersion: typeof ATTENTION_EVENT_SCHEMA_VERSION;
	readonly events: readonly AttentionEvent[];
	readonly failedUnacknowledged: boolean;
	readonly status: AttentionStoreStatus;
}

export interface AttentionStoreMutationResult {
	readonly ok: boolean;
	readonly status: AttentionStoreStatus;
	readonly changed: boolean;
}

export interface AttentionStoreLoadResult {
	readonly status: AttentionStoreStatus;
}

export interface AttentionEventStoreOptions {
	readonly path?: string;
	readonly filePath?: string;
	readonly rootDir?: string;
	readonly maxTerminalHistory?: number;
	readonly maxIdentities?: number;
	readonly now?: () => number;
}

interface PersistedStore {
	schemaVersion: typeof ATTENTION_EVENT_SCHEMA_VERSION;
	events: AttentionEvent[];
}

interface MutableAttentionEvent {
	kind: string;
	sourceId: string;
	generation: string;
	label: string;
	status: AttentionEventStatus;
	startedAt: number;
	updatedAt: number;
	revision: number;
	acknowledgedRevision?: number;
}

const ACTIVE_STATUSES = new Set<AttentionEventStatus>(["running", "waiting"]);
const TERMINAL_STATUSES = new Set<AttentionEventStatus>(["done", "failed", "cancelled"]);

function isAttentionEventStatus(value: unknown): value is AttentionEventStatus {
	switch (value) {
		case "running":
		case "waiting":
		case "done":
		case "failed":
		case "cancelled":
			return true;
		default:
			return false;
	}
}
const MAX_KIND_LENGTH = 48;
const MAX_SOURCE_ID_LENGTH = 192;
const MAX_GENERATION_LENGTH = 192;
const MAX_LABEL_LENGTH = 160;
const MAX_EVENTS_ON_LOAD = 10_000;

const EMPTY_SNAPSHOT: AttentionStoreSnapshot = Object.freeze({
	schemaVersion: ATTENTION_EVENT_SCHEMA_VERSION,
	events: Object.freeze([]),
	failedUnacknowledged: false,
	status: "memory_only",
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

function isMissing(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function isFiniteTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function boundedString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		!/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function safeIdentityPart(value: unknown, maxLength: number): string | undefined {
	if (!boundedString(value, maxLength)) return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) return undefined;
	return value;
}

function normalizeIdentity(value: unknown): AttentionEventIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const kind = safeIdentityPart(value.kind, MAX_KIND_LENGTH);
	const sourceId = safeIdentityPart(value.sourceId, MAX_SOURCE_ID_LENGTH);
	const generation = safeIdentityPart(value.generation, MAX_GENERATION_LENGTH);
	if (!kind || !sourceId || !generation) return undefined;
	return { kind, sourceId, generation };
}

function isRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function sanitizeLabel(value: unknown): string {
	if (typeof value !== "string") return "Task";
	let label = value
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (label.length === 0) return "Task";
	// Persist only a display label. Do not carry path-like or credential-like values
	// into the local attention snapshot, even when a producer supplied one.
	label = label
		.replace(/(?:^|\s)(?:~|\.{1,2}|\/|[A-Za-z]:[\\/])[^\s]*/gu, " …")
		.replace(/\b(?:api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^\s]+/giu, "$1=[redacted]")
		.replace(/\b(?:sk|pk|ghp|xox[baprs])-[-_A-Za-z0-9]+/gu, "[redacted]")
		.replace(/\bhttps?:\/\/[^\s]+/giu, "[redacted-url]")
		.replace(/\s+/gu, " ")
		.trim();
	if (label.length === 0) return "Task";
	return label.slice(0, MAX_LABEL_LENGTH);
}

function identityKey(identity: AttentionEventIdentity): string {
	return JSON.stringify([identity.kind, identity.sourceId, identity.generation]);
}

function compareEvents(a: MutableAttentionEvent, b: MutableAttentionEvent): number {
	return (
		b.updatedAt - a.updatedAt ||
		b.startedAt - a.startedAt ||
		a.kind.localeCompare(b.kind) ||
		a.sourceId.localeCompare(b.sourceId) ||
		a.generation.localeCompare(b.generation)
	);
}

function cloneEvent(event: MutableAttentionEvent): MutableAttentionEvent {
	return { ...event };
}

function immutableEvent(event: MutableAttentionEvent): AttentionEvent {
	return Object.freeze({ ...event });
}

function isActiveFailure(event: MutableAttentionEvent): boolean {
	return event.status === "failed" && event.acknowledgedRevision !== event.revision;
}

function isActiveAttention(event: MutableAttentionEvent): boolean {
	return ACTIVE_STATUSES.has(event.status) || isActiveFailure(event);
}

function validatePersistedEvent(value: unknown): MutableAttentionEvent | undefined {
	if (!isRecord(value)) return undefined;
	const kind = safeIdentityPart(value.kind, MAX_KIND_LENGTH);
	const sourceId = safeIdentityPart(value.sourceId, MAX_SOURCE_ID_LENGTH);
	const generation = safeIdentityPart(value.generation, MAX_GENERATION_LENGTH);
	const status = value.status;
	const label = value.label;
	const revisionValue = value.revision;
	if (
		!kind ||
		!sourceId ||
		!generation ||
		!isAttentionEventStatus(status) ||
		!boundedString(label, MAX_LABEL_LENGTH) ||
		!isFiniteTimestamp(value.startedAt) ||
		!isFiniteTimestamp(value.updatedAt) ||
		typeof revisionValue !== "number" ||
		!Number.isSafeInteger(revisionValue) ||
		revisionValue < 1
	)
		return undefined;
	const revision = revisionValue;
	const acknowledgedRevisionValue = value.acknowledgedRevision;
	let acknowledgedRevision: number | undefined;
	if (acknowledgedRevisionValue !== undefined) {
		if (
			typeof acknowledgedRevisionValue !== "number" ||
			!Number.isSafeInteger(acknowledgedRevisionValue) ||
			acknowledgedRevisionValue < 1 ||
			acknowledgedRevisionValue > revision
		)
			return undefined;
		acknowledgedRevision = acknowledgedRevisionValue;
	}
	return {
		kind,
		sourceId,
		generation,
		label: sanitizeLabel(label),
		status,
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
		revision,
		...(acknowledgedRevision === undefined ? {} : { acknowledgedRevision }),
	};
}

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/**
 * A small, local, revision-aware attention ledger. It stores only bounded task
 * observations; task managers remain the owners of task lifecycle and output.
 */
export class AttentionEventStore {
	readonly #filePath: string | undefined;
	readonly #rootDir: string | undefined;
	readonly #maxTerminalHistory: number;
	readonly #maxIdentities: number;
	readonly #now: () => number;
	readonly #events = new Map<string, MutableAttentionEvent>();
	#snapshot: AttentionStoreSnapshot = EMPTY_SNAPSHOT;
	#status: AttentionStoreStatus = "memory_only";
	#dirty = false;
	#disposed = false;
	#tempSequence = 0;
	#queue: Promise<void> = Promise.resolve();

	constructor(pathOrOptions?: string | AttentionEventStoreOptions, secondaryOptions?: AttentionEventStoreOptions) {
		const options: AttentionEventStoreOptions =
			typeof pathOrOptions === "string" ? { ...secondaryOptions, path: pathOrOptions } : (pathOrOptions ?? {});
		const requestedPath = options.path ?? options.filePath;
		this.#rootDir = options.rootDir === undefined ? undefined : path.resolve(options.rootDir);
		this.#maxTerminalHistory = Math.max(
			0,
			Math.min(
				MAX_ATTENTION_TERMINAL_HISTORY,
				Math.floor(options.maxTerminalHistory ?? MAX_ATTENTION_TERMINAL_HISTORY),
			),
		);
		const configuredMaxIdentities = options.maxIdentities ?? MAX_ATTENTION_IDENTITIES;
		this.#maxIdentities = Number.isFinite(configuredMaxIdentities)
			? Math.max(0, Math.min(MAX_ATTENTION_IDENTITIES, Math.floor(configuredMaxIdentities)))
			: MAX_ATTENTION_IDENTITIES;
		this.#now = options.now ?? Date.now;
		if (requestedPath !== undefined) {
			const resolved = this.#validatePathSync(requestedPath);
			if (resolved === undefined) {
				this.#status = "invalid_path";
			} else {
				this.#filePath = resolved;
				this.#status = "ready";
				this.#loadSync();
			}
		}
		this.#refreshSnapshot();
	}

	get filePath(): string | undefined {
		return this.#filePath;
	}

	getSnapshot(): AttentionStoreSnapshot {
		return this.#snapshot;
	}

	get events(): readonly AttentionEvent[] {
		return this.#snapshot.events;
	}

	get failedUnacknowledged(): boolean {
		return this.#snapshot.failedUnacknowledged;
	}

	getStatus(): AttentionStoreStatus {
		return this.#status;
	}

	/** The constructor loads synchronously; this method is an explicit stable load receipt. */
	async load(): Promise<AttentionStoreLoadResult> {
		return { status: this.#status };
	}

	observe(observation: AttentionObservation): Promise<AttentionStoreMutationResult> {
		if (this.#disposed) return Promise.resolve({ ok: false, status: "unavailable", changed: false });
		if (this.#status === "corrupt" || this.#status === "invalid_path")
			return Promise.resolve({ ok: false, status: this.#status, changed: false });
		const normalized = this.#normalizeObservation(observation);
		if (normalized === undefined) return Promise.resolve({ ok: false, status: this.#status, changed: false });
		return this.#enqueue(async () => {
			const key = identityKey(normalized);
			const previous = new Map<string, MutableAttentionEvent>();
			for (const [previousKey, event] of this.#events) previous.set(previousKey, cloneEvent(event));
			const existing = this.#events.get(key);
			let changed = false;
			if (existing === undefined) {
				if (!this.#makeRoomForIdentity()) {
					this.#status = "overflow";
					this.#refreshSnapshot();
					return { ok: false, status: "overflow", changed: false };
				}
				const timestamp = normalized.observedAt ?? this.#now();
				this.#events.set(key, {
					kind: normalized.kind,
					sourceId: normalized.sourceId,
					generation: normalized.generation,
					label: normalized.label,
					status: normalized.status,
					startedAt: normalized.startedAt,
					updatedAt: timestamp,
					revision: 1,
				});
				changed = true;
			} else if (existing.label !== normalized.label || existing.status !== normalized.status) {
				existing.label = normalized.label;
				existing.status = normalized.status;
				existing.updatedAt = normalized.observedAt ?? this.#now();
				existing.revision += 1;
				delete existing.acknowledgedRevision;
				changed = true;
			}
			const evicted = this.#evict();
			changed = changed || evicted;
			this.#dirty ||= changed;
			this.#refreshSnapshot();
			if (!changed && !this.#dirty) return { ok: true, status: this.#status, changed: false };
			const ok = await this.#persistCurrent();
			if (!ok) {
				this.#events.clear();
				for (const [previousKey, event] of previous) this.#events.set(previousKey, event);
				this.#dirty = true;
				this.#refreshSnapshot();
				return { ok: false, status: this.#status, changed: false };
			}
			return { ok: true, status: this.#status, changed };
		});
	}

	/** Alias useful to callers that model observations as events. */
	record(observation: AttentionObservation): Promise<AttentionStoreMutationResult> {
		return this.observe(observation);
	}

	acknowledge(identity: AttentionEventIdentity, revision: number): Promise<AttentionStoreMutationResult> {
		if (this.#disposed) return Promise.resolve({ ok: false, status: "unavailable", changed: false });
		if (this.#status === "corrupt" || this.#status === "invalid_path")
			return Promise.resolve({ ok: false, status: this.#status, changed: false });
		const normalized = normalizeIdentity(identity);
		if (!normalized || !isRevision(revision))
			return Promise.resolve({ ok: false, status: this.#status, changed: false });
		return this.#enqueue(async () => {
			const key = identityKey(normalized);
			const event = this.#events.get(key);
			if (!event || event.status !== "failed" || !isActiveFailure(event) || event.revision !== revision)
				return { ok: false, status: this.#status, changed: false };
			const previous = cloneEvent(event);
			event.acknowledgedRevision = revision;
			const ok = await this.#persistCurrent();
			if (!ok) {
				this.#events.set(key, previous);
				this.#dirty = true;
				this.#refreshSnapshot();
				return { ok: false, status: this.#status, changed: false };
			}
			this.#refreshSnapshot();
			return { ok: true, status: this.#status, changed: true };
		});
	}

	acknowledgeFailures(expected: readonly AttentionEventAcknowledgement[]): Promise<AttentionStoreMutationResult> {
		if (this.#disposed) return Promise.resolve({ ok: false, status: "unavailable", changed: false });
		if (this.#status === "corrupt" || this.#status === "invalid_path")
			return Promise.resolve({ ok: false, status: this.#status, changed: false });
		if (!Array.isArray(expected)) return Promise.resolve({ ok: false, status: this.#status, changed: false });
		const normalized: AttentionEventAcknowledgement[] = [];
		const keys = new Set<string>();
		for (const item of expected) {
			const identity = normalizeIdentity(item);
			if (!identity || !isRevision(item.revision))
				return Promise.resolve({ ok: false, status: this.#status, changed: false });
			const key = identityKey(identity);
			if (keys.has(key)) return Promise.resolve({ ok: false, status: this.#status, changed: false });
			keys.add(key);
			normalized.push({ ...identity, revision: item.revision });
		}
		return this.#enqueue(async () => {
			for (const item of normalized) {
				const event = this.#events.get(identityKey(item));
				if (!event || event.status !== "failed" || !isActiveFailure(event) || event.revision !== item.revision)
					return { ok: false, status: this.#status, changed: false };
			}
			if (normalized.length === 0) return { ok: true, status: this.#status, changed: false };
			const previous = new Map<string, MutableAttentionEvent>();
			for (const [key, event] of this.#events) previous.set(key, cloneEvent(event));
			for (const item of normalized) {
				const event = this.#events.get(identityKey(item));
				if (event) event.acknowledgedRevision = item.revision;
			}
			const ok = await this.#persistCurrent();
			if (!ok) {
				this.#events.clear();
				for (const [key, event] of previous) this.#events.set(key, event);
				this.#dirty = true;
				this.#refreshSnapshot();
				return { ok: false, status: this.#status, changed: false };
			}
			this.#refreshSnapshot();
			return { ok: true, status: this.#status, changed: true };
		});
	}

	async flush(): Promise<AttentionStoreLoadResult> {
		await this.#queue;
		return { status: this.#status };
	}

	dispose(): void {
		this.#disposed = true;
	}

	#normalizeObservation(observation: AttentionObservation): AttentionObservation | undefined {
		if (!observation || typeof observation !== "object") return undefined;
		const kind = safeIdentityPart(observation.kind, MAX_KIND_LENGTH);
		const sourceId = safeIdentityPart(observation.sourceId, MAX_SOURCE_ID_LENGTH);
		const generation = safeIdentityPart(observation.generation, MAX_GENERATION_LENGTH);
		if (!kind || !sourceId || !generation || !isAttentionEventStatus(observation.status)) return undefined;
		if (!isFiniteTimestamp(observation.startedAt)) return undefined;
		if (observation.observedAt !== undefined && !isFiniteTimestamp(observation.observedAt)) return undefined;
		return {
			kind,
			sourceId,
			generation,
			label: sanitizeLabel(observation.label),
			status: observation.status,
			startedAt: observation.startedAt,
			...(observation.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
		};
	}

	#refreshSnapshot(): void {
		const events = [...this.#events.values()].sort(compareEvents).map(immutableEvent);
		const failedUnacknowledged = events.some(
			event => event.status === "failed" && event.acknowledgedRevision !== event.revision,
		);
		this.#snapshot = Object.freeze({
			schemaVersion: ATTENTION_EVENT_SCHEMA_VERSION,
			events: Object.freeze(events),
			failedUnacknowledged,
			status: this.#status,
		});
	}

	#makeRoomForIdentity(): boolean {
		if (this.#maxIdentities === 0) return false;
		if (this.#events.size < this.#maxIdentities) return true;
		const removable = [...this.#events.entries()]
			.filter(([, event]) => TERMINAL_STATUSES.has(event.status) && !isActiveAttention(event))
			.sort(([, a], [, b]) => compareEvents(b, a));
		const required = this.#events.size - this.#maxIdentities + 1;
		if (removable.length < required) return false;
		for (const [key] of removable.slice(0, required)) this.#events.delete(key);
		return true;
	}

	#evict(): boolean {
		const terminal = [...this.#events.entries()]
			.filter(([, event]) => TERMINAL_STATUSES.has(event.status) && !isActiveAttention(event))
			.sort(([, a], [, b]) => compareEvents(a, b));
		if (terminal.length <= this.#maxTerminalHistory) return false;
		for (const [key] of terminal.slice(this.#maxTerminalHistory)) this.#events.delete(key);
		return true;
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(operation, operation);
		this.#queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	#validatePathSync(requested: string): string | undefined {
		if (requested.length === 0 || requested.includes("\u0000")) return undefined;
		const target = path.resolve(requested);
		if (this.#rootDir !== undefined && !isWithin(this.#rootDir, target)) return undefined;
		let current = target;
		while (true) {
			try {
				const stat = fsSync.lstatSync(current);
				if (stat.isSymbolicLink()) return undefined;
				if (current === target && stat.isDirectory()) return undefined;
				if (current !== target && !stat.isDirectory()) return undefined;
				if (current === target && !stat.isFile()) return undefined;
				current = path.dirname(current);
			} catch (error) {
				if (!isMissing(error)) return undefined;
				const parent = path.dirname(current);
				if (parent === current) break;
				current = parent;
			}
			if (this.#rootDir !== undefined && current === this.#rootDir) break;
			if (current === path.dirname(current)) break;
		}
		return target;
	}

	#loadSync(): void {
		if (!this.#filePath) return;
		let source: string;
		try {
			source = fsSync.readFileSync(this.#filePath, "utf8");
		} catch (error) {
			if (isMissing(error)) return;
			this.#status = "unavailable";
			return;
		}
		try {
			const parsed: unknown = JSON.parse(source);
			if (
				!isRecord(parsed) ||
				parsed.schemaVersion !== ATTENTION_EVENT_SCHEMA_VERSION ||
				!Array.isArray(parsed.events)
			) {
				this.#status = "corrupt";
				return;
			}
			if (parsed.events.length > MAX_EVENTS_ON_LOAD) {
				this.#status = "corrupt";
				return;
			}
			const loaded = new Map<string, MutableAttentionEvent>();
			for (const value of parsed.events) {
				const event = validatePersistedEvent(value);
				if (!event) {
					this.#status = "corrupt";
					return;
				}
				const key = identityKey(event);
				if (loaded.has(key)) {
					this.#status = "corrupt";
					return;
				}
				loaded.set(key, event);
			}
			for (const [key, event] of loaded) this.#events.set(key, event);
			this.#evict();
			if (this.#events.size > this.#maxIdentities) {
				const removable = [...this.#events.entries()]
					.filter(([, event]) => TERMINAL_STATUSES.has(event.status) && !isActiveAttention(event))
					.sort(([, a], [, b]) => compareEvents(b, a));
				const required = this.#events.size - this.#maxIdentities;
				if (removable.length >= required) {
					for (const [key] of removable.slice(0, required)) this.#events.delete(key);
				} else {
					this.#status = "overflow";
				}
			}
		} catch {
			this.#events.clear();
			this.#status = "corrupt";
		}
	}

	async #persistCurrent(): Promise<boolean> {
		if (!this.#filePath) {
			this.#dirty = false;
			this.#status = "memory_only";
			this.#refreshSnapshot();
			return true;
		}
		if (this.#status === "invalid_path" || this.#status === "corrupt") return false;
		const target = await this.#validatePathAsync();
		if (!target) {
			this.#status = "invalid_path";
			this.#refreshSnapshot();
			return false;
		}
		let temp: string | undefined;
		try {
			await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			const afterMkdir = await this.#validatePathAsync();
			if (!afterMkdir) {
				this.#status = "invalid_path";
				this.#refreshSnapshot();
				return false;
			}
			temp = `${target}.${process.pid}.${++this.#tempSequence}.tmp`;
			const handle = await fs.open(temp, "wx", 0o600);
			try {
				const value: PersistedStore = {
					schemaVersion: ATTENTION_EVENT_SCHEMA_VERSION,
					events: [...this.#events.values()].sort(compareEvents).map(cloneEvent),
				};
				await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temp, target);
			this.#dirty = false;
			this.#status = "ready";
			this.#refreshSnapshot();
			return true;
		} catch {
			if (temp !== undefined) await fs.unlink(temp).catch(() => undefined);
			this.#status = "write_failed";
			this.#dirty = true;
			this.#refreshSnapshot();
			return false;
		}
	}

	async #validatePathAsync(): Promise<string | undefined> {
		if (!this.#filePath) return undefined;
		const target = this.#filePath;
		if (this.#rootDir !== undefined && !isWithin(this.#rootDir, target)) return undefined;
		let current = target;
		while (true) {
			try {
				const stat = await fs.lstat(current);
				if (stat.isSymbolicLink()) return undefined;
				if (current === target && stat.isDirectory()) return undefined;
				if (current !== target && !stat.isDirectory()) return undefined;
				if (current === target && !stat.isFile()) return undefined;
				current = path.dirname(current);
			} catch (error) {
				if (!isMissing(error)) return undefined;
				const parent = path.dirname(current);
				if (parent === current) break;
				current = parent;
			}
			if (this.#rootDir !== undefined && current === this.#rootDir) break;
			if (current === path.dirname(current)) break;
		}
		return target;
	}
}

export function attentionIdentityKey(identity: AttentionEventIdentity): string {
	return identityKey(identity);
}
