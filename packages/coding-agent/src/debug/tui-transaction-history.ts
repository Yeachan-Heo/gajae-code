import { createHash } from "node:crypto";
import type { TuiTransactionObservation } from "@gajae-code/tui";

const DEFAULT_CAPACITY = 256;

export interface TuiTransactionRecord {
	readonly sessionId: string;
	readonly sequence: number;
	readonly timestamp: number;
	readonly operation?: TuiTransactionObservation["operation"];
	readonly outcome: TuiTransactionObservation["outcome"];
	readonly byteLength: number;
	readonly sha256: string;
}

export interface TuiTransactionHistorySnapshot {
	readonly records: readonly TuiTransactionRecord[];
	readonly droppedRecords: number;
	readonly totalSharedObservations: number;
}

export interface TuiTransactionHistoryOptions {
	/** Maximum number of metadata records retained in memory. Defaults to 256. */
	capacity?: number;
	/** Clock used for observation timestamps. Defaults to Date.now. */
	now?: () => number;
}

/** Runtime-only, metadata-only history for shared TUI write observations. */
export class TuiTransactionHistory {
	readonly #capacity: number;
	readonly #now: () => number;
	#records: TuiTransactionRecord[] = [];
	#droppedRecords = 0;
	#totalSharedObservations = 0;
	#nextSequence = 1;

	constructor(options: TuiTransactionHistoryOptions = {}) {
		const capacity = options.capacity ?? DEFAULT_CAPACITY;
		if (!Number.isInteger(capacity) || capacity <= 0) {
			throw new RangeError("TUI transaction history capacity must be a positive integer");
		}
		this.#capacity = capacity;
		this.#now = options.now ?? Date.now;
	}

	record(observation: TuiTransactionObservation, sessionId: string): void {
		if (observation.classification !== "shared") return;

		const record: TuiTransactionRecord = Object.freeze({
			sessionId,
			sequence: this.#nextSequence++,
			timestamp: this.#now(),
			operation: observation.operation,
			outcome: observation.outcome,
			byteLength: Buffer.byteLength(observation.bytes, "utf8"),
			sha256: createHash("sha256").update(observation.bytes, "utf8").digest("hex"),
		});
		this.#totalSharedObservations += 1;
		this.#records.push(record);
		while (this.#records.length > this.#capacity) {
			this.#records.shift();
			this.#droppedRecords += 1;
		}
	}

	snapshot(): TuiTransactionHistorySnapshot {
		return Object.freeze({
			records: Object.freeze([...this.#records]),
			droppedRecords: this.#droppedRecords,
			totalSharedObservations: this.#totalSharedObservations,
		});
	}
}
