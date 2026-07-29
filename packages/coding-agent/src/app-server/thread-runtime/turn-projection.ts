import type { ThreadItem } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/ThreadItem";
import type { Turn } from "../../../vendor/codex-app-server-schema/stable/typescript/v2/Turn";
import { stableValidators } from "../protocol-source/schema-validators.generated";
import type { SessionClient } from "./child-bridge";

export const PROJECTION_SCHEMA_VERSION = 1 as const;

export const PROJECTION_RECORD_KINDS = {
	turnCreated: "app-server.turn.created",
	itemCompleted: "app-server.turn.item.completed",
	terminal: "app-server.turn.terminal",
} as const;

export const TURN_CREATED_RECORD_KIND = PROJECTION_RECORD_KINDS.turnCreated;
export const TURN_ITEM_COMPLETED_RECORD_KIND = PROJECTION_RECORD_KINDS.itemCompleted;
export const TURN_TERMINAL_RECORD_KIND = PROJECTION_RECORD_KINDS.terminal;

export type ProjectionRecordKind = (typeof PROJECTION_RECORD_KINDS)["turnCreated" | "itemCompleted" | "terminal"];

export interface TurnCreatedPayload {
	readonly turn: Turn;
	readonly commandId: string;
	readonly turnId: string;
	readonly clientRef: string;
	readonly replayToken?: string;
}

export interface TurnItemCompletedPayload {
	readonly turnId: string;
	readonly item: ThreadItem;
	readonly order: number;
	readonly completedAtMs?: number;
}

export interface TurnTerminalPayload {
	readonly turn: Turn;
}

export type ProjectionPayload = TurnCreatedPayload | TurnItemCompletedPayload | TurnTerminalPayload;

export interface ProjectionEnvelope<P extends ProjectionPayload = ProjectionPayload> {
	readonly schemaVersion: typeof PROJECTION_SCHEMA_VERSION;
	readonly recordKind: ProjectionRecordKind;
	readonly sourceKey: string;
	readonly payload: P;
}

/** A durable read record carries a revision; newly constructed append envelopes do not. */
export interface ProjectionRecord<P extends ProjectionPayload = ProjectionPayload> extends ProjectionEnvelope<P> {
	readonly revision?: number;
}

export interface ProjectionAppendReceipt<P extends ProjectionPayload = ProjectionPayload> {
	readonly record: ProjectionRecord<P> & { readonly revision: number };
	readonly revision: number;
	readonly response: unknown;
}

export interface ProjectionReadResult {
	readonly records: readonly (ProjectionRecord & { readonly revision: number })[];
	readonly revision: number;
}

export class ProjectionCorruptError extends Error {
	readonly code = "projection_corrupt" as const;

	constructor(message: string) {
		super(message);
		this.name = "ProjectionCorruptError";
	}
}

export class ProjectionAppendError extends Error {
	constructor(
		readonly code: "projection_append_failed" | "idempotency_conflict",
		message: string,
	) {
		super(message);
		this.name = "ProjectionAppendError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new ProjectionCorruptError(`Projection ${field} is missing.`);
	return value;
}

function finiteInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value))
		throw new ProjectionCorruptError(`Projection ${field} is not a safe integer.`);
	return value;
}
function positiveRevision(value: unknown, field: string): number {
	const revision = finiteInteger(value, field);
	if (revision <= 0) throw new ProjectionCorruptError(`Projection ${field} must be positive.`);
	return revision;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (!isRecord(value)) return JSON.stringify(value) ?? "undefined";
	return `{${Object.keys(value)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
		.join(",")}}`;
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function validateTurn(value: unknown, field: string): Turn {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) {
		throw new ProjectionCorruptError(`Projection ${field} has no turn.id.`);
	}
	const validator = stableValidators.clientRequestResults["turn/start"];
	if (!validator?.({ turn: value }))
		throw new ProjectionCorruptError(`Projection ${field} has an invalid Turn snapshot.`);
	return value as Turn;
}

function validateItem(value: unknown): ThreadItem {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) {
		throw new ProjectionCorruptError("Projection item snapshot has no id.");
	}
	const candidateTurn: Record<string, unknown> = {
		id: "projection-item-validation",
		items: [value],
		itemsView: "full",
		status: "inProgress",
		error: null,
		startedAt: null,
		completedAt: null,
		durationMs: null,
	};
	const validator = stableValidators.clientRequestResults["turn/start"];
	if (!validator?.({ turn: candidateTurn })) throw new ProjectionCorruptError("Projection item snapshot is invalid.");
	return value as ThreadItem;
}

function appendResultCandidate(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const result = value.result;
	return isRecord(result) ? result : value;
}

function revisionFromAppend(value: unknown): number {
	const candidate = appendResultCandidate(value);
	const revision = candidate?.revision;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0)
		throw new ProjectionAppendError("projection_append_failed", "projection.append returned an invalid revision.");
	return revision;
}

function errorFromOperation(value: unknown): { code?: string; message?: string } | undefined {
	if (!isRecord(value)) return undefined;
	const nested = isRecord(value.error) ? value.error : undefined;
	const code = nested?.code ?? value.code ?? value.errorKey;
	const message = nested?.message ?? value.message;
	if (typeof code !== "string" && typeof message !== "string") return undefined;
	return {
		...(typeof code === "string" ? { code } : {}),
		...(typeof message === "string" ? { message } : {}),
	};
}

export function turnCreatedSourceKey(turnId: string, commandId: string, childTurnId: string): string {
	return `turn:${turnId}:child:${commandId}:${childTurnId}:created`;
}

export function turnItemCompletedSourceKey(
	turnId: string,
	itemId: string,
	commandId: string,
	childTurnId: string,
): string {
	return `turn:${turnId}:child:${commandId}:${childTurnId}:item:${itemId}:completed`;
}

export function turnTerminalSourceKey(turnId: string, commandId: string, childTurnId: string): string {
	return `turn:${turnId}:child:${commandId}:${childTurnId}:terminal`;
}

export function makeTurnCreatedRecord(payload: TurnCreatedPayload): ProjectionEnvelope<TurnCreatedPayload> {
	return {
		schemaVersion: PROJECTION_SCHEMA_VERSION,
		recordKind: TURN_CREATED_RECORD_KIND,
		sourceKey: turnCreatedSourceKey(payload.turn.id, payload.commandId, payload.turnId),
		payload,
	};
}

export function makeTurnItemCompletedRecord(
	payload: TurnItemCompletedPayload,
	mapping: Pick<TurnCreatedPayload, "commandId" | "turnId">,
	appTurnId = payload.turnId,
): ProjectionEnvelope<TurnItemCompletedPayload> {
	return {
		schemaVersion: PROJECTION_SCHEMA_VERSION,
		recordKind: TURN_ITEM_COMPLETED_RECORD_KIND,
		sourceKey: turnItemCompletedSourceKey(appTurnId, payload.item.id, mapping.commandId, mapping.turnId),
		payload,
	};
}

export function makeTurnTerminalRecord(
	payload: TurnTerminalPayload,
	mapping: Pick<TurnCreatedPayload, "commandId" | "turnId">,
): ProjectionEnvelope<TurnTerminalPayload> {
	return {
		schemaVersion: PROJECTION_SCHEMA_VERSION,
		recordKind: TURN_TERMINAL_RECORD_KIND,
		sourceKey: turnTerminalSourceKey(payload.turn.id, mapping.commandId, mapping.turnId),
		payload,
	};
}

function normalizeEnvelope(value: unknown): ProjectionRecord {
	if (!isRecord(value)) throw new ProjectionCorruptError("Projection record is not an object.");
	const allowedKeys = new Set(["schemaVersion", "recordKind", "sourceKey", "payload", "revision"]);
	if (Object.keys(value).some(key => !allowedKeys.has(key)))
		throw new ProjectionCorruptError("Projection record has unexpected fields.");
	if (value.schemaVersion !== PROJECTION_SCHEMA_VERSION)
		throw new ProjectionCorruptError("Projection record has an unsupported schema version.");
	const recordKind = value.recordKind;
	if (
		recordKind !== TURN_CREATED_RECORD_KIND &&
		recordKind !== TURN_ITEM_COMPLETED_RECORD_KIND &&
		recordKind !== TURN_TERMINAL_RECORD_KIND
	)
		throw new ProjectionCorruptError("Projection record has an unknown record kind.");
	const sourceKey = requiredString(value.sourceKey, "sourceKey");

	if (!Object.hasOwn(value, "payload")) throw new ProjectionCorruptError("Projection record has no payload.");
	const rawPayload = value.payload;
	if (!isRecord(rawPayload)) throw new ProjectionCorruptError("Projection record payload is not an object.");
	if (recordKind === TURN_CREATED_RECORD_KIND) {
		const turn = validateTurn(rawPayload.turn, "created.turn");
		const commandId = requiredString(rawPayload.commandId, "created.commandId");
		const turnId = requiredString(rawPayload.turnId, "created.turnId");
		const clientRef = requiredString(rawPayload.clientRef, "created.clientRef");
		if (rawPayload.replayToken !== undefined) requiredString(rawPayload.replayToken, "created.replayToken");
		if (turn.status !== "inProgress") throw new ProjectionCorruptError("Created Turn snapshot must be inProgress.");
		if (turn.items.length !== 0) throw new ProjectionCorruptError("Created Turn snapshot must start with no items.");
		if (sourceKey !== turnCreatedSourceKey(turn.id, commandId, turnId))
			throw new ProjectionCorruptError("Created projection source key does not match its identities.");
		return {
			schemaVersion: PROJECTION_SCHEMA_VERSION,
			recordKind,
			sourceKey,
			...(value.revision === undefined ? {} : { revision: positiveRevision(value.revision, "revision") }),
			payload: {
				turn,
				commandId,
				turnId,
				clientRef,
				...(rawPayload.replayToken === undefined ? {} : { replayToken: rawPayload.replayToken as string }),
			},
		};
	}

	if (recordKind === TURN_ITEM_COMPLETED_RECORD_KIND) {
		const turnId = requiredString(rawPayload.turnId, "item.turnId");
		const item = validateItem(rawPayload.item);
		const order = finiteInteger(rawPayload.order, "item.order");
		if (order < 0) throw new ProjectionCorruptError("Projection item order cannot be negative.");
		const completedAtMs =
			rawPayload.completedAtMs === undefined
				? undefined
				: finiteInteger(rawPayload.completedAtMs, "item.completedAtMs");
		return {
			schemaVersion: PROJECTION_SCHEMA_VERSION,
			recordKind,
			sourceKey,
			...(value.revision === undefined ? {} : { revision: positiveRevision(value.revision, "revision") }),
			payload: { turnId, item, order, ...(completedAtMs === undefined ? {} : { completedAtMs }) },
		};
	}
	const turn = validateTurn(rawPayload.turn, "terminal.turn");
	if (turn.status === "inProgress") throw new ProjectionCorruptError("Terminal Turn snapshot is still in progress.");
	return {
		schemaVersion: PROJECTION_SCHEMA_VERSION,
		recordKind,
		sourceKey,
		...(value.revision === undefined ? {} : { revision: positiveRevision(value.revision, "revision") }),
		payload: { turn },
	};
}

export function validateProjectionRecord(value: unknown): ProjectionRecord {
	return normalizeEnvelope(value);
}

export async function appendProjectionRecord<P extends ProjectionPayload>(
	client: SessionClient,
	record: ProjectionEnvelope<P>,
): Promise<ProjectionAppendReceipt<P>> {
	const normalized = normalizeEnvelope(record) as ProjectionRecord<P>;
	const response = await client.control(
		"projection.append",
		{ envelope: normalized },
		{
			idempotencyKey: normalized.sourceKey,
			confirm: true,
		},
	);
	const operationError = errorFromOperation(response);
	if (operationError?.code !== undefined || operationError?.message !== undefined) {
		const candidate = appendResultCandidate(response);
		if (candidate?.ok === false || candidate?.error !== undefined || candidate?.code !== undefined) {
			throw new ProjectionAppendError(
				operationError.code === "idempotency_conflict" ? "idempotency_conflict" : "projection_append_failed",
				operationError.message ?? `projection.append failed (${operationError.code ?? "unknown"}).`,
			);
		}
	}
	const revision = revisionFromAppend(response);
	return {
		record: { ...normalized, revision },
		revision,
		response,
	};
}

export async function readProjectionRecords(client: SessionClient, afterRevision = 0): Promise<ProjectionReadResult> {
	if (!Number.isSafeInteger(afterRevision) || afterRevision < 0)
		throw new ProjectionCorruptError("afterRevision is invalid.");
	const response = await client.control("projection.read", { afterRevision });
	const candidate = appendResultCandidate(response);
	if (candidate?.ok === false || candidate?.error !== undefined) {
		const operationError = errorFromOperation(response);
		throw new ProjectionAppendError("projection_append_failed", operationError?.message ?? "projection.read failed.");
	}
	if (!candidate || !Array.isArray(candidate.records))
		throw new ProjectionCorruptError("projection.read returned malformed records.");
	const revision = finiteInteger(candidate.revision, "read.revision");
	if (revision < afterRevision) throw new ProjectionCorruptError("projection.read revision moved backwards.");
	if (candidate.records.length !== revision - afterRevision)
		throw new ProjectionCorruptError("projection.read returned a non-contiguous revision range.");
	const records = candidate.records.map((rawRecord, index) => {
		if (!isRecord(rawRecord) || typeof rawRecord.entryId !== "string" || !isRecord(rawRecord.envelope))
			throw new ProjectionCorruptError("projection.read returned a malformed entry wrapper.");
		const expectedRevision = afterRevision + index + 1;
		const normalized = normalizeEnvelope(rawRecord.envelope);
		if (normalized.revision !== undefined && normalized.revision !== expectedRevision)
			throw new ProjectionCorruptError("projection.read record revision does not match its ordinal.");
		return { ...normalized, revision: expectedRevision };
	});
	return { records, revision };
}

interface CreatedState {
	readonly payload: TurnCreatedPayload;
	readonly turn: Turn;
	readonly itemsById: Map<string, ThreadItem>;
	readonly ordersByItem: Map<string, number>;
	readonly itemByOrder: Map<number, string>;
	terminal?: Turn;
	orderBase?: number;
}

function stateKey(commandId: string, turnId: string): string {
	return `${commandId}\u0000${turnId}`;
}

function cloneTurn(turn: Turn): Turn {
	return structuredClone(turn);
}

function cloneItem(item: ThreadItem): ThreadItem {
	return structuredClone(item);
}

export class TurnProjectionReducer {
	readonly #turns = new Map<string, CreatedState>();
	readonly #turnOrder: string[] = [];
	readonly #sourceRecords = new Map<string, ProjectionRecord>();
	readonly #childToTurn = new Map<string, string>();
	readonly #clientRefToTurn = new Map<string, string>();
	#lastRevision: number | undefined;

	get lastRevision(): number | undefined {
		return this.#lastRevision;
	}

	get size(): number {
		return this.#turns.size;
	}

	apply(value: ProjectionRecord | ProjectionEnvelope): Turn | undefined {
		const record = normalizeEnvelope(value);
		const prior = this.#sourceRecords.get(record.sourceKey);
		if (prior !== undefined) {
			if (!sameJson(prior.payload, record.payload) || prior.recordKind !== record.recordKind)
				throw new ProjectionCorruptError(`Projection source key ${record.sourceKey} conflicts.`);
			// The durable store reuses the original ordinal for a valid idempotent retry, so the same
			// source key at a different revision is a duplicated log record, not an accepted replay.
			if (record.revision !== undefined && prior.revision !== undefined && prior.revision !== record.revision)
				throw new ProjectionCorruptError(
					`Projection source key ${record.sourceKey} is duplicated at revision ${record.revision}.`,
				);
			return this.snapshot(this.turnIdForRecord(record));
		}
		this.#observeRevision(record.revision);
		this.#sourceRecords.set(record.sourceKey, record);
		switch (record.recordKind) {
			case TURN_CREATED_RECORD_KIND:
				return this.#applyCreated(record.payload as TurnCreatedPayload);
			case TURN_ITEM_COMPLETED_RECORD_KIND: {
				const payload = record.payload as TurnItemCompletedPayload;
				const state = this.#turns.get(payload.turnId);
				if (state !== undefined) {
					const expectedSource = turnItemCompletedSourceKey(
						payload.turnId,
						payload.item.id,
						state.payload.commandId,
						state.payload.turnId,
					);
					if (record.sourceKey !== expectedSource)
						throw new ProjectionCorruptError(`Item ${payload.item.id} source key does not match its identities.`);
				}
				return this.#applyItem(payload);
			}
			case TURN_TERMINAL_RECORD_KIND: {
				const payload = record.payload as TurnTerminalPayload;
				const state = this.#turns.get(payload.turn.id);
				if (state !== undefined) {
					const expectedSource = turnTerminalSourceKey(
						payload.turn.id,
						state.payload.commandId,
						state.payload.turnId,
					);
					if (record.sourceKey !== expectedSource)
						throw new ProjectionCorruptError(
							`Terminal turn ${payload.turn.id} source key does not match its identities.`,
						);
				}
				return this.#applyTerminal(payload);
			}
		}
	}

	applyRecord(value: ProjectionRecord | ProjectionEnvelope): Turn | undefined {
		return this.apply(value);
	}
	reduce(value: ProjectionRecord | ProjectionEnvelope): Turn | undefined {
		return this.apply(value);
	}

	turnIdForRecord(record: ProjectionRecord | ProjectionEnvelope): string {
		const payload = normalizeEnvelope(record).payload;
		return "turn" in payload ? payload.turn.id : payload.turnId;
	}

	snapshot(turnId: string): Turn {
		const state = this.#turns.get(turnId);
		if (!state) throw new ProjectionCorruptError(`Projection references unknown turn ${turnId}.`);
		return cloneTurn(state.terminal ?? state.turn);
	}
	current(turnId: string): Turn {
		return this.snapshot(turnId);
	}

	snapshots(): readonly Turn[] {
		return this.#turnOrder.map(turnId => this.snapshot(turnId));
	}

	orderedSnapshots(): readonly Turn[] {
		return this.snapshots();
	}

	nextItemOrder(turnId: string): number {
		const state = this.#turns.get(turnId);
		if (!state) throw new ProjectionCorruptError(`Projection references unknown turn ${turnId}.`);
		if (state.ordersByItem.size === 0) return state.orderBase ?? 0;
		const orderBase = state.orderBase;
		if (orderBase === undefined) throw new ProjectionCorruptError("Projection item order base is missing.");
		return orderBase + state.ordersByItem.size;
	}

	mapping(turnId: string): TurnCreatedPayload {
		const state = this.#turns.get(turnId);
		if (!state) throw new ProjectionCorruptError(`Projection references unknown turn ${turnId}.`);
		return state.payload;
	}

	#observeRevision(revision: number | undefined): void {
		if (revision === undefined) {
			if (this.#lastRevision !== undefined)
				throw new ProjectionCorruptError("Projection revision is missing after a revised record.");
			return;
		}
		if (this.#lastRevision !== undefined && revision !== this.#lastRevision + 1)
			throw new ProjectionCorruptError(`Projection revision gap at ${revision}.`);
		this.#lastRevision = revision;
	}

	#applyCreated(payload: TurnCreatedPayload): Turn {
		const turnId = payload.turn.id;
		const childKey = stateKey(payload.commandId, payload.turnId);
		const existingChild = this.#childToTurn.get(childKey);
		if (existingChild !== undefined && existingChild !== turnId)
			throw new ProjectionCorruptError(`Child mapping ${childKey} belongs to multiple turns.`);
		const existingRef = this.#clientRefToTurn.get(payload.clientRef);
		if (existingRef !== undefined && existingRef !== turnId)
			throw new ProjectionCorruptError(`clientRef ${payload.clientRef} belongs to multiple turns.`);
		const existing = this.#turns.get(turnId);
		if (existing !== undefined) {
			if (!sameJson(existing.payload, payload))
				throw new ProjectionCorruptError(`Turn ${turnId} was created twice with conflicting mapping.`);
			return cloneTurn(existing.turn);
		}
		const state: CreatedState = {
			payload,
			turn: cloneTurn(payload.turn),
			itemsById: new Map(),
			ordersByItem: new Map(),
			itemByOrder: new Map(),
		};
		this.#turns.set(turnId, state);
		this.#turnOrder.push(turnId);
		this.#childToTurn.set(childKey, turnId);
		this.#clientRefToTurn.set(payload.clientRef, turnId);
		return cloneTurn(state.turn);
	}

	#applyItem(payload: TurnItemCompletedPayload): Turn {
		const state = this.#turns.get(payload.turnId);
		if (!state) throw new ProjectionCorruptError(`Item ${payload.item.id} precedes its created turn.`);
		if (state.terminal !== undefined)
			throw new ProjectionCorruptError(`Item ${payload.item.id} follows terminal turn ${payload.turnId}.`);
		if (state.orderBase === undefined) {
			if (payload.order !== 0 && payload.order !== 1)
				throw new ProjectionCorruptError("Projection item order has a gap.");
			state.orderBase = payload.order;
		}
		const existingItem = state.itemsById.get(payload.item.id);
		if (existingItem !== undefined) {
			if (state.ordersByItem.get(payload.item.id) !== payload.order || !sameJson(existingItem, payload.item))
				throw new ProjectionCorruptError(`Item ${payload.item.id} was completed with conflicting data.`);
			return cloneTurn(state.turn);
		}
		const existingItemAtOrder = state.itemByOrder.get(payload.order);
		if (existingItemAtOrder !== undefined && existingItemAtOrder !== payload.item.id)
			throw new ProjectionCorruptError(`Projection order ${payload.order} is assigned to two items.`);
		const expectedOrder = state.orderBase + state.itemsById.size;
		if (payload.order !== expectedOrder)
			throw new ProjectionCorruptError(`Projection item order gap at ${payload.order}.`);
		state.itemsById.set(payload.item.id, cloneItem(payload.item));
		state.ordersByItem.set(payload.item.id, payload.order);
		state.itemByOrder.set(payload.order, payload.item.id);
		state.turn.items = [...state.turn.items, cloneItem(payload.item)];
		return cloneTurn(state.turn);
	}

	#applyTerminal(payload: TurnTerminalPayload): Turn {
		const turnId = payload.turn.id;
		const state = this.#turns.get(turnId);
		if (!state) throw new ProjectionCorruptError(`Terminal turn ${turnId} precedes its created turn.`);
		if (state.terminal !== undefined) {
			if (!sameJson(state.terminal, payload.turn))
				throw new ProjectionCorruptError(`Turn ${turnId} has conflicting terminal snapshots.`);
			return cloneTurn(state.terminal);
		}
		if (payload.turn.items.length !== state.itemsById.size)
			throw new ProjectionCorruptError(`Terminal turn ${turnId} has open items.`);
		for (let index = 0; index < payload.turn.items.length; index += 1) {
			const item = payload.turn.items[index];
			const expectedItemId = state.itemByOrder.get((state.orderBase ?? 0) + index);
			if (expectedItemId !== item.id)
				throw new ProjectionCorruptError(`Terminal turn ${turnId} has unstable item order.`);
			const persistedItem = state.itemsById.get(item.id);
			if (!persistedItem || !sameJson(persistedItem, item))
				throw new ProjectionCorruptError(`Terminal turn ${turnId} has an unpersisted item.`);
		}
		state.terminal = cloneTurn(payload.turn);
		return cloneTurn(state.terminal);
	}
}

function normalizedRecords(
	records: readonly (ProjectionRecord | ProjectionEnvelope | unknown)[],
): readonly ProjectionRecord[] {
	if (records.length === 0) throw new ProjectionCorruptError("Projection is empty; no historical turns exist.");
	const hasRevision = records.map(record => isRecord(record) && Object.hasOwn(record, "revision"));
	if (hasRevision.some(Boolean) && hasRevision.some(value => !value))
		throw new ProjectionCorruptError("Projection records mix revised and unrevised entries.");
	return records.map((record, index) => {
		const normalized = normalizeEnvelope(record);
		if (!hasRevision[0]) return { ...normalized, revision: index + 1 };
		return normalized;
	});
}

export function reconstructTurnSnapshots(records: readonly unknown[]): readonly Turn[] {
	const reducer = new TurnProjectionReducer();
	for (const record of normalizedRecords(records)) reducer.apply(record);
	return reducer.snapshots();
}

export async function readAndReconstructTurns(client: SessionClient): Promise<readonly Turn[]> {
	const result = await readProjectionRecords(client, 0);
	return reconstructTurnSnapshots(result.records);
}
