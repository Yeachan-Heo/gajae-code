import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { MAX_PINNED_REVISIONS, type RevisionStore, RevisionStoreError, SNAPSHOT_TTL_MS } from "./revision-store.js";

export const CURSOR_TTL_MS = SNAPSHOT_TTL_MS;
export const MAX_CURSORS_PER_CONNECTION = 32;
export const MAX_CURSORS_PER_SESSION = MAX_PINNED_REVISIONS;

export interface CursorEnvelope {
	cursorVersion: 1;
	protocolMajor: 3;
	sessionId: string;
	resource: string;
	/** Unique per-grant identity so identical envelopes never alias into one pin. */
	nonce?: string;
	revision: string;
	highWatermark?: unknown;
	/** TTL metadata minted by `CursorRegistry.grant`: wall-clock ms when granted. */
	issuedAt?: number;
	/** TTL metadata minted by `CursorRegistry.grant`: wall-clock ms when the cursor expires. */
	expiresAt?: number;
	purpose?: "checkpoint";
	position: unknown;
	direction: string;
	pageShape: unknown;
}

export interface CursorSelector {
	queryId: string;
	entryId?: string;
	field?: string;
	fileId?: string;
	hunkId?: string;
	resourceKind?: string;
	resourceId?: string;
	itemId?: string;
	kind?: string;
	clientRef?: string;
	commandId?: string;
	turnId?: string;
}

export interface CursorPosition {
	offset?: number;
	byteOffset?: number;
	selector?: CursorSelector;
}

export function cursorSelector(position: unknown): CursorSelector | undefined {
	if (!position || typeof position !== "object") return undefined;
	const selector = (position as CursorPosition).selector;
	return selector && typeof selector.queryId === "string" ? selector : undefined;
}

export function assertCursorSelector(
	cursor: CursorSelector | undefined,
	requested: Partial<CursorSelector>,
): CursorSelector {
	if (!cursor) throw new CursorError("invalid_input", false, "cursor does not match query");
	for (const [key, value] of Object.entries(requested)) {
		if (value !== undefined && cursor[key as keyof CursorSelector] !== value)
			throw new CursorError("invalid_input", false, "cursor does not match query");
	}
	return cursor;
}

export interface CursorQueryContext {
	sessionId: string;
	resource?: string;
	resourceId?: string;
	direction: string;
	pageShape: unknown;
	purpose?: "checkpoint";
}

export class CursorError extends Error {
	constructor(
		readonly code:
			| "cursor_expired"
			| "invalid_cursor"
			| "invalid_input"
			| "resource_gone"
			| "snapshot_capacity_exceeded",
		readonly restartQuery = code === "cursor_expired",
		message: string = code,
	) {
		super(message);
	}
}

function canonicalise(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalise);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, canonicalise(entry)]),
		);
	return value;
}

/** Cursor MAC basis: localeCompare key order, then JSON.stringify (drops undefined properties, array holes become null). */
function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalise(value));
}
export function canonicalCursorJson(envelope: CursorEnvelope): string {
	return canonicalJson(envelope);
}
export function cursorMac(envelope: CursorEnvelope, sessionToken: string | Uint8Array): string {
	return createHmac("sha256", sessionToken).update(canonicalCursorJson(envelope)).digest("hex");
}
export function signCursor(envelope: CursorEnvelope, sessionToken: string | Uint8Array): string {
	return JSON.stringify({ envelope, mac: cursorMac(envelope, sessionToken) });
}
export function verifyCursor(cursor: string, sessionToken: string | Uint8Array): CursorEnvelope | undefined {
	try {
		const signed = JSON.parse(cursor) as { envelope: CursorEnvelope; mac: string };
		const expected = Buffer.from(cursorMac(signed.envelope, sessionToken), "hex");
		const actual = Buffer.from(signed.mac, "hex");
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
		const envelope = signed.envelope;
		return envelope.cursorVersion === 1 && envelope.protocolMajor === 3 ? envelope : undefined;
	} catch {
		return undefined;
	}
}

interface ActiveCursor {
	connectionId: string;
	resourceId: string;
	expiresAt: number;
}

/** Tracks cursor budgets and binds snapshot pins to authenticated cursor strings. */
export class CursorRegistry {
	readonly #active = new Map<string, ActiveCursor>();
	constructor(
		private readonly sessionToken: string | Uint8Array,
		private readonly revisions: RevisionStore,
		private readonly now: () => number = Date.now,
	) {}

	async grant(
		connectionId: string,
		envelope: CursorEnvelope,
		resourceKind: string,
		resourceId: string,
	): Promise<string> {
		this.sweep();
		if (
			this.#active.size >= MAX_CURSORS_PER_SESSION ||
			[...this.#active.values()].filter(item => item.connectionId === connectionId).length >=
				MAX_CURSORS_PER_CONNECTION
		)
			throw new CursorError("snapshot_capacity_exceeded", false);
		// Mint the authoritative TTL inside the registry so the signed envelope
		// and the active-entry expiry can never diverge; callers read
		// `issuedAt`/`expiresAt` back from the envelope they passed in.
		const issuedAt = this.now();
		envelope.issuedAt = issuedAt;
		envelope.expiresAt = issuedAt + CURSOR_TTL_MS;
		const cursor = signCursor(envelope, this.sessionToken);
		try {
			await this.revisions.pin(cursor, resourceKind, resourceId, envelope.revision);
		} catch (error) {
			if (error instanceof RevisionStoreError) throw new CursorError(error.code, false);
			throw error;
		}
		this.#active.set(cursor, { connectionId, resourceId, expiresAt: envelope.expiresAt });
		return cursor;
	}

	async exchange(
		cursor: string,
		connectionId: string,
		expected: CursorQueryContext,
		_resourceKind: string,
		resourceId: string,
	): Promise<{ cursor: string; envelope: CursorEnvelope }> {
		const envelope = verifyCursor(cursor, this.sessionToken);
		if (!envelope) {
			this.release(cursor);
			throw new CursorError("invalid_cursor", true);
		}
		const source = this.#active.get(cursor);
		if (!source || envelope.expiresAt === undefined) {
			this.release(cursor);
			throw new CursorError("invalid_cursor", true);
		}
		const validatedAt = this.now();
		if (source.expiresAt <= validatedAt || envelope.expiresAt <= validatedAt) {
			this.release(cursor);
			throw new CursorError("cursor_expired");
		}
		if (
			envelope.sessionId !== expected.sessionId ||
			(expected.resource !== undefined && envelope.resource !== expected.resource) ||
			envelope.direction !== expected.direction ||
			canonicalJson(envelope.pageShape) !== canonicalJson(expected.pageShape) ||
			envelope.purpose !== expected.purpose ||
			_resourceKind !== envelope.resource ||
			source.resourceId !== resourceId
		)
			throw new CursorError("invalid_input", false, "cursor does not match query");
		// Preserve the already-validated source while removing expired target
		// grants before capacity accounting. The shared timestamp prevents the
		// source from changing classification at a TTL boundary mid-exchange.
		this.sweep(cursor, validatedAt);
		const targetConnectionCount = [...this.#active.values()].filter(
			item => item.connectionId === connectionId,
		).length;
		if (
			this.#active.size > MAX_CURSORS_PER_SESSION ||
			targetConnectionCount - (source.connectionId === connectionId ? 1 : 0) >= MAX_CURSORS_PER_CONNECTION
		)
			throw new CursorError("snapshot_capacity_exceeded", false);
		const exchanged: CursorEnvelope = {
			...envelope,
			nonce: randomUUID(),
			issuedAt: undefined,
			expiresAt: undefined,
		};
		const issuedAt = this.now();
		exchanged.issuedAt = issuedAt;
		exchanged.expiresAt = issuedAt + CURSOR_TTL_MS;
		const exchangedCursor = signCursor(exchanged, this.sessionToken);
		try {
			this.revisions.transferPin(cursor, exchangedCursor);
		} catch (error) {
			if (error instanceof RevisionStoreError) throw new CursorError(error.code, false, error.message);
			throw error;
		}
		this.#active.delete(cursor);
		this.#active.set(exchangedCursor, {
			connectionId,
			resourceId,
			expiresAt: exchanged.expiresAt,
		});
		return { cursor: exchangedCursor, envelope: exchanged };
	}

	consume(cursor: string, connectionId: string, expected: CursorQueryContext): CursorEnvelope {
		const envelope = verifyCursor(cursor, this.sessionToken);
		if (!envelope) throw new CursorError("invalid_cursor", false);
		const active = this.#active.get(cursor);
		const expired =
			!active ||
			active.connectionId !== connectionId ||
			active.expiresAt <= this.now() ||
			(envelope.expiresAt !== undefined && envelope.expiresAt <= this.now());
		if (expired) {
			this.release(cursor);
			throw new CursorError("cursor_expired");
		}
		if (
			envelope.sessionId !== expected.sessionId ||
			(expected.resource !== undefined && envelope.resource !== expected.resource) ||
			envelope.direction !== expected.direction ||
			canonicalJson(envelope.pageShape) !== canonicalJson(expected.pageShape) ||
			(expected.resourceId !== undefined && active.resourceId !== expected.resourceId)
		) {
			throw new CursorError("invalid_input", false, "cursor does not match query");
		}
		this.release(cursor);
		return envelope;
	}

	release(cursor: string): void {
		this.#active.delete(cursor);
		this.revisions.unpin(cursor);
	}

	close(): void {
		for (const cursor of this.#active.keys()) this.release(cursor);
	}
	sweep(exceptCursor?: string, at = this.now()): void {
		for (const [cursor, active] of this.#active)
			if (cursor !== exceptCursor && active.expiresAt <= at) this.release(cursor);
		this.revisions.sweep();
	}
	get size(): number {
		return this.#active.size;
	}
}
