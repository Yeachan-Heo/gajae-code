import * as crypto from "node:crypto";

import type { ParsedIrcMessage } from "./utils/irc-message";

type InlineMode = "persistent" | "ephemeral";

const MAX_RECORDS = 10_000;
const MAX_RETAINED_UTF8_BYTES = 16 * 1024 * 1024;
const MAX_SEEN_IDENTITIES = 100_000;

export type IrcObservationRecord = Readonly<
	ParsedIrcMessage & {
		mode: InlineMode;
		observedAt: number;
		sequence: number;
		expiresAt?: number;
		retainedUtf8Bytes: number;
	}
>;

function measureRetainedUtf8Bytes(message: ParsedIrcMessage): number {
	let bytes = 4;
	for (const value of [message.observationId, message.from, message.to, message.text, message.kind]) {
		bytes += Buffer.byteLength(value, "utf8");
		if (bytes > MAX_RETAINED_UTF8_BYTES) return bytes;
	}
	return bytes;
}

function tombstoneIdentity(observationId: string): string {
	const hash = crypto.createHash("sha256");
	hash.update("gjc:irc:observation-id:utf16le:v1\0");
	for (let offset = 0; offset < observationId.length; offset += 4_096) {
		hash.update(Buffer.from(observationId.slice(offset, offset + 4_096), "utf16le"));
	}
	return hash.digest("hex");
}

/** Runtime-only IRC observations. This intentionally has no persistence layer. */
export class IrcObservationLedger {
	#records = new Map<string, IrcObservationRecord>();
	#retainedUtf8Bytes = 0;
	#nextSequence = 0;
	#seenObservationIdentities = new Set<string>();
	#identityCapacityExhausted = false;
	#evictedObservationIds = new Set<string>();

	#rememberObservationIdentity(observationId: string): boolean {
		const identity = tombstoneIdentity(observationId);
		if (this.#seenObservationIdentities.has(identity) || this.#identityCapacityExhausted) return false;
		if (this.#seenObservationIdentities.size >= MAX_SEEN_IDENTITIES) {
			this.#identityCapacityExhausted = true;
			return false;
		}
		this.#seenObservationIdentities.add(identity);
		return true;
	}

	#evict(observationId: string): void {
		const record = this.#records.get(observationId);
		if (!record) return;
		this.#records.delete(observationId);
		this.#retainedUtf8Bytes -= record.retainedUtf8Bytes;
		this.#evictedObservationIds.add(observationId);
	}

	#enforceBounds(): void {
		while (this.#records.size > MAX_RECORDS || this.#retainedUtf8Bytes > MAX_RETAINED_UTF8_BYTES) {
			const oldestObservationId = this.#records.keys().next().value;
			if (oldestObservationId === undefined) return;
			this.#evict(oldestObservationId);
		}
	}

	/** Inline observations expire after 10 seconds; closed-panel observations persist inline. */
	observe(message: ParsedIrcMessage, panelVisibleAtObservation: boolean): IrcObservationRecord | undefined {
		const existing = this.#records.get(message.observationId);
		if (existing) return existing;
		if (!this.#rememberObservationIdentity(message.observationId)) return undefined;

		const estimatedBytes = measureRetainedUtf8Bytes(message);
		if (estimatedBytes > MAX_RETAINED_UTF8_BYTES) return undefined;

		const observedAt = Date.now();
		const mode: InlineMode = panelVisibleAtObservation ? "ephemeral" : "persistent";
		const record: IrcObservationRecord = Object.freeze({
			...message,
			mode,
			observedAt,
			sequence: this.#nextSequence++,
			...(mode === "ephemeral" ? { expiresAt: observedAt + 10_000 } : {}),
			retainedUtf8Bytes: estimatedBytes,
		});
		this.#records.set(record.observationId, record);
		this.#retainedUtf8Bytes += estimatedBytes;
		this.#enforceBounds();
		return this.#records.get(record.observationId);
	}

	getRecord(observationId: string): IrcObservationRecord | undefined {
		return this.#records.get(observationId);
	}

	getSidebarRecords(): readonly IrcObservationRecord[] {
		return [...this.#records.values()];
	}

	getInlineProjection(now: number): readonly IrcObservationRecord[] {
		return [...this.#records.values()].filter(record => record.mode === "persistent" || now < record.expiresAt!);
	}

	/** Returns and clears IDs whose retained payload was released. */
	drainEvictedObservationIds(): readonly string[] {
		const observationIds = [...this.#evictedObservationIds];
		this.#evictedObservationIds.clear();
		return observationIds;
	}

	reset(): void {
		for (const observationId of this.#records.keys()) {
			this.#evictedObservationIds.add(observationId);
		}
		this.#records.clear();
		this.#retainedUtf8Bytes = 0;
		this.#nextSequence = 0;
	}
}
