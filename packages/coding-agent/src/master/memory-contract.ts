import { randomUUID } from "node:crypto";
import type { MemoryActivity } from "./types";

export type MemoryScope = "global";

export interface MemoryContext {
	masterName: string;
	taskId?: string;
	workerSessionId?: string;
}

export interface MemoryReadInput {
	scope: MemoryScope;
	query: string;
	limit: number;
	context: MemoryContext;
	signal?: AbortSignal;
}

export interface MemoryEntry {
	id: string;
	content: string;
	tags: readonly string[];
	createdAt: string;
	source: {
		masterName: string;
		taskId?: string;
		workerSessionId?: string;
		decisionId?: string;
	};
}

export interface MemoryReadResult {
	activityId: string;
	entries: readonly MemoryEntry[];
}

export interface MemoryWriteInput {
	scope: MemoryScope;
	content: string;
	tags: readonly string[];
	source: {
		masterName: string;
		taskId?: string;
		workerSessionId?: string;
		decisionId?: string;
	};
	idempotencyKey: string;
	signal?: AbortSignal;
}

export interface MemoryWriteReceipt {
	activityId: string;
	entryId: string;
}

export interface MemoryContract {
	readonly version: 1;
	read(input: MemoryReadInput): Promise<MemoryReadResult>;
	write(input: MemoryWriteInput): Promise<MemoryWriteReceipt>;
	subscribe(listener: (activity: MemoryActivity) => void): () => void;
}

export class MemoryUnavailableError extends Error {
	readonly code = "memory_unavailable" as const;
	constructor(message = "memory provider is unavailable") {
		super(message);
		this.name = "MemoryUnavailableError";
	}
}

export class MemoryConflictError extends Error {
	readonly code = "memory_conflict" as const;
	constructor(message = "memory idempotency key was reused with different content") {
		super(message);
		this.name = "MemoryConflictError";
	}
}

function assertScope(scope: MemoryScope): void {
	if (scope !== "global") throw new TypeError("memory scope must be global");
}

function assertSignal(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function assertString(value: unknown, label: string): void {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function assertText(value: string, label: string): void {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
}

function assertContext(context: MemoryContext): void {
	if (!context || typeof context !== "object") throw new TypeError("memory context is required");
	assertText(context.masterName, "masterName");
	if (context.taskId !== undefined) assertText(context.taskId, "taskId");
	if (context.workerSessionId !== undefined) assertText(context.workerSessionId, "workerSessionId");
}

function assertSource(source: MemoryWriteInput["source"]): void {
	if (!source || typeof source !== "object") throw new TypeError("memory source is required");
	assertText(source.masterName, "source.masterName");
	if (source.taskId !== undefined) assertText(source.taskId, "source.taskId");
	if (source.workerSessionId !== undefined) assertText(source.workerSessionId, "source.workerSessionId");
	if (source.decisionId !== undefined) assertText(source.decisionId, "source.decisionId");
}

function activityId(): string {
	return `memory:${randomUUID()}`;
}

function now(): string {
	return new Date().toISOString();
}

function makeActivity(
	operation: MemoryActivity["operation"],
	activity: string,
	masterName: string,
	summary: string,
	occurredAt: string,
	extra: Pick<MemoryActivity, "taskId" | "workerSessionId" | "entryIds"> = {},
): MemoryActivity {
	const value: MemoryActivity = {
		activityId: activity,
		operation,
		scope: "global",
		masterName,
		summary,
		occurredAt,
	};
	if (extra.taskId !== undefined) value.taskId = extra.taskId;
	if (extra.workerSessionId !== undefined) value.workerSessionId = extra.workerSessionId;
	if (extra.entryIds !== undefined) value.entryIds = extra.entryIds;
	return value;
}

export class UnavailableMemoryContract implements MemoryContract {
	readonly version = 1 as const;
	readonly reason: string;
	constructor(reason = "memory provider is unavailable") {
		this.reason = reason;
	}
	read(_input: MemoryReadInput): Promise<MemoryReadResult> {
		return Promise.reject(new MemoryUnavailableError(this.reason));
	}
	write(_input: MemoryWriteInput): Promise<MemoryWriteReceipt> {
		return Promise.reject(new MemoryUnavailableError(this.reason));
	}
	subscribe(_listener: (activity: MemoryActivity) => void): () => void {
		return () => undefined;
	}
}

export function createUnavailableMemoryContract(reason?: string): MemoryContract {
	return new UnavailableMemoryContract(reason);
}

export const unavailableMemoryContract: MemoryContract = new UnavailableMemoryContract();
export const NO_MEMORY_CONTRACT = unavailableMemoryContract;

interface StoredWrite {
	content: string;
	tags: readonly string[];
	source: MemoryWriteInput["source"];
	receipt: MemoryWriteReceipt;
}

export interface DeterministicMemoryContractOptions {
	clock?: () => Date;
	idFactory?: () => string;
}

export class DeterministicMemoryContract implements MemoryContract {
	readonly version = 1 as const;
	readonly #entries: MemoryEntry[] = [];
	readonly #writes = new Map<string, StoredWrite>();
	readonly #listeners = new Set<(activity: MemoryActivity) => void>();
	readonly #clock: () => Date;
	readonly #idFactory: () => string;
	#activitySequence = 0;

	constructor(options: DeterministicMemoryContractOptions = {}) {
		this.#clock = options.clock ?? (() => new Date(0));
		this.#idFactory = options.idFactory ?? (() => `fake-${this.#entries.length + 1}`);
	}

	read(input: MemoryReadInput): Promise<MemoryReadResult> {
		assertScope(input.scope);
		assertString(input.query, "query");
		assertContext(input.context);
		assertSignal(input.signal);
		if (!Number.isSafeInteger(input.limit) || input.limit < 1)
			return Promise.reject(new TypeError("memory read limit must be a positive safe integer"));
		const query = input.query.toLocaleLowerCase();
		const entries = this.#entries
			.filter(entry => entry.content.toLocaleLowerCase().includes(query))
			.slice(0, input.limit);
		const id = this.#nextActivityId();
		const activity = makeActivity(
			"read",
			id,
			input.context.masterName,
			`read ${entries.length} memory entr${entries.length === 1 ? "y" : "ies"}`,
			this.#clock().toISOString(),
			{
				taskId: input.context.taskId,
				workerSessionId: input.context.workerSessionId,
				entryIds: entries.slice(0, 32).map(entry => entry.id),
			},
		);
		this.#publish(activity);
		return Promise.resolve({
			activityId: id,
			entries: entries.map(entry => ({ ...entry, tags: [...entry.tags], source: { ...entry.source } })),
		});
	}

	write(input: MemoryWriteInput): Promise<MemoryWriteReceipt> {
		assertScope(input.scope);
		assertText(input.content, "content");
		assertText(input.idempotencyKey, "idempotencyKey");
		assertSource(input.source);
		assertSignal(input.signal);
		if (input.tags.some(tag => typeof tag !== "string" || tag.length === 0))
			return Promise.reject(new TypeError("memory tags must be non-empty strings"));
		const existing = this.#writes.get(input.idempotencyKey);
		if (existing) {
			if (!sameWrite(existing, input)) return Promise.reject(new MemoryConflictError());
			return Promise.resolve({ ...existing.receipt });
		}
		const entryId = this.#idFactory();
		const activity = this.#nextActivityId();
		const entry: MemoryEntry = {
			id: entryId,
			content: input.content,
			tags: [...input.tags],
			createdAt: this.#clock().toISOString(),
			source: { ...input.source },
		};
		this.#entries.push(entry);
		const receipt = { activityId: activity, entryId };
		this.#writes.set(input.idempotencyKey, {
			content: input.content,
			tags: [...input.tags],
			source: { ...input.source },
			receipt,
		});
		this.#publish(
			makeActivity(
				"write",
				activity,
				input.source.masterName,
				`write memory entry ${entryId}`,
				this.#clock().toISOString(),
				{
					taskId: input.source.taskId,
					workerSessionId: input.source.workerSessionId,
					entryIds: [entryId],
				},
			),
		);
		return Promise.resolve({ ...receipt });
	}

	subscribe(listener: (activity: MemoryActivity) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	entries(): readonly MemoryEntry[] {
		return this.#entries.map(entry => ({ ...entry, tags: [...entry.tags], source: { ...entry.source } }));
	}

	clear(): void {
		this.#entries.length = 0;
		this.#writes.clear();
		this.#activitySequence = 0;
	}

	#nextActivityId(): string {
		this.#activitySequence += 1;
		return `activity-${this.#activitySequence}`;
	}

	#publish(activity: MemoryActivity): void {
		for (const listener of this.#listeners)
			listener({ ...activity, entryIds: activity.entryIds ? [...activity.entryIds] : undefined });
	}
}

function sameWrite(existing: StoredWrite, input: MemoryWriteInput): boolean {
	if (existing.content !== input.content || existing.tags.length !== input.tags.length) return false;
	for (let index = 0; index < existing.tags.length; index += 1)
		if (existing.tags[index] !== input.tags[index]) return false;
	return JSON.stringify(existing.source) === JSON.stringify(input.source);
}

export function createDeterministicMemoryContract(
	options?: DeterministicMemoryContractOptions,
): DeterministicMemoryContract {
	return new DeterministicMemoryContract(options);
}

export const createFakeMemoryContract = createDeterministicMemoryContract;
export const FakeMemoryContract = DeterministicMemoryContract;
export const unavailableMemory = unavailableMemoryContract;

export function isMemoryUnavailable(error: unknown): error is MemoryUnavailableError {
	return error instanceof MemoryUnavailableError;
}

export function memoryActivityForRead(
	masterName: string,
	summary: string,
	activityIdValue = activityId(),
): MemoryActivity {
	assertText(masterName, "masterName");
	assertText(summary, "summary");
	return makeActivity("read", activityIdValue, masterName, summary, now());
}
