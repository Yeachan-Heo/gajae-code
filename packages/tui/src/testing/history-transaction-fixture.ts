/**
 * Small, production-safe recorder for the shared renderer transaction boundary.
 *
 * The recorder deliberately does not inspect or infer history from terminal bytes.
 * Callers provide the state transitions through `record`'s callback; the callback
 * runs only after the tagged payload has passed validation and failure injection.
 */

export const SHARED_TRANSACTION_OPERATIONS = [
	"primary",
	"ft-restore",
	"page",
	"page-entry-or-repaint",
	"follow",
	"ime",
] as const;

export type SharedTransactionOperation = (typeof SHARED_TRANSACTION_OPERATIONS)[number];
export type TransactionOperation = SharedTransactionOperation;
export type TransactionOperationTag = SharedTransactionOperation;
export type TransactionClassification = "shared" | "exempt";
export type TransactionOutcome = "accepted" | "rejected" | "failed";

export interface CursorSnapshot {
	readonly row: number;
	readonly column: number;
}

export interface HistoryStateSnapshot {
	readonly scrollbackLength: number;
	readonly cpCount: number;
	readonly eventCount: number;
	readonly ledgerCount: number;
	readonly viewportTop: number;
	readonly viewportBottom: number;
	readonly cursor: CursorSnapshot;
}

export interface HistoryStateInput {
	scrollbackLength?: number;
	cpCount?: number;
	eventCount?: number;
	ledgerCount?: number;
	viewportTop?: number;
	viewportBottom?: number;
	cursor?: Partial<CursorSnapshot>;
}

export interface HistoryTransactionRecord {
	readonly domainId: string;
	readonly operation: SharedTransactionOperation | undefined;
	readonly bytes: string;
	readonly pre: HistoryStateSnapshot;
	readonly post: HistoryStateSnapshot;
	readonly outcome: "accepted" | "rejected";
	readonly error?: string;
}
export type ObservableTransactionRecord = HistoryTransactionRecord;
export type StateSnapshot = HistoryStateSnapshot;
export type TaggedAttempt = TaggedWriteAttempt;

export interface TaggedWriteAttempt {
	readonly ordinal: number;
	readonly classification: TransactionClassification;
	readonly operation?: SharedTransactionOperation;
	readonly bytes: string;
	readonly outcome: TransactionOutcome;
	readonly error?: string;
}

export interface SuccessfulWrite {
	readonly ordinal: number;
	readonly classification: TransactionClassification;
	readonly operation?: SharedTransactionOperation;
	readonly bytes: string;
}

export interface ExemptPhysicalOutputObservation {
	readonly ordinal: number;
	readonly bytes: string;
	readonly outcome: "accepted" | "failed";
	readonly error?: string;
}

export interface HistoryTransactionFixtureOptions {
	readonly domainId?: string;
	readonly state?: HistoryStateInput;
	readonly snapshot?: () => HistoryStateSnapshot;
}

export class TransactionFixtureError extends Error {
	readonly code: "invalid-operation" | "erase-sequence" | "incomplete-csi" | "injected-failure";

	constructor(
		code: TransactionFixtureError["code"],
		message: string,
	) {
		super(message);
		this.name = "TransactionFixtureError";
		this.code = code;
	}
}

const DEFAULT_STATE: HistoryStateSnapshot = {
	scrollbackLength: 0,
	cpCount: 0,
	eventCount: 0,
	ledgerCount: 0,
	viewportTop: 0,
	viewportBottom: 0,
	cursor: { row: 0, column: 0 },
};

const CSI_PARAMETER = (value: number): boolean => value >= 0x30 && value <= 0x3f;
const CSI_INTERMEDIATE = (value: number): boolean => value >= 0x20 && value <= 0x2f;
const CSI_FINAL = (value: number): boolean => value >= 0x40 && value <= 0x7e;

function freezeSnapshot(input: HistoryStateInput | HistoryStateSnapshot): HistoryStateSnapshot {
	const cursor = "cursor" in input && input.cursor ? input.cursor : undefined;
	return Object.freeze({
		scrollbackLength: input.scrollbackLength ?? DEFAULT_STATE.scrollbackLength,
		cpCount: input.cpCount ?? DEFAULT_STATE.cpCount,
		eventCount: input.eventCount ?? DEFAULT_STATE.eventCount,
		ledgerCount: input.ledgerCount ?? DEFAULT_STATE.ledgerCount,
		viewportTop: input.viewportTop ?? DEFAULT_STATE.viewportTop,
		viewportBottom: input.viewportBottom ?? DEFAULT_STATE.viewportBottom,
		cursor: Object.freeze({
			row: cursor?.row ?? DEFAULT_STATE.cursor.row,
			column: cursor?.column ?? DEFAULT_STATE.cursor.column,
		}),
	});
}

function isSharedOperation(value: unknown): value is SharedTransactionOperation {
	return typeof value === "string" &&
		(SHARED_TRANSACTION_OPERATIONS as readonly string[]).includes(value);
}

function csiEnd(bytes: string, start: number): number | undefined {
	for (let index = start; index < bytes.length; index += 1) {
		const value = bytes.charCodeAt(index);
		if (CSI_FINAL(value)) return index;
		if (!CSI_PARAMETER(value) && !CSI_INTERMEDIATE(value)) return undefined;
	}
	return undefined;
}

/**
 * Returns a rejection reason for erase CSI or an incomplete CSI candidate.
 * Both 7-bit ESC-[ and 8-bit 0x9b forms are checked. Incomplete candidates are
 * rejected at the boundary so they cannot become an erase sequence across writes.
 */
export function getCsiEraseGuardFailure(bytes: string):
	| { readonly code: "erase-sequence" | "incomplete-csi"; readonly message: string }
	| undefined {
	for (let index = 0; index < bytes.length; index += 1) {
		const escape = bytes.charCodeAt(index) === 0x1b;
		const csi8 = bytes.charCodeAt(index) === 0x9b;
		if (!csi8 && (!escape || bytes.charCodeAt(index + 1) !== 0x5b)) continue;

		const start = csi8 ? index + 1 : index + 2;
		if (start >= bytes.length) {
			return {
				code: "incomplete-csi",
				message: csi8 ? "incomplete 8-bit CSI" : "incomplete 7-bit CSI (ESC [)",
			};
		}

		const end = csiEnd(bytes, start);
		if (end === undefined) {
			return {
				code: "incomplete-csi",
				message: csi8 ? "incomplete 8-bit CSI" : "incomplete 7-bit CSI (ESC [)",
			};
		}
		const final = bytes.charCodeAt(end);
		if (final === 0x4a || final === 0x4b) {
			return {
				code: "erase-sequence",
				message: `renderer transaction contains CSI ${String.fromCharCode(final)} erase`,
			};
		}
		index = end;
	}

	// A bare ESC at the end is also an incomplete cross-commit candidate. A
	// complete non-CSI ESC sequence is not part of the shared erase guard.
	if (bytes.charCodeAt(bytes.length - 1) === 0x1b) {
		return { code: "incomplete-csi", message: "incomplete bare ESC" };
	}
	return undefined;
}

export function assertSafeSharedTransaction(bytes: string): void {
	const failure = getCsiEraseGuardFailure(bytes);
	if (failure) throw new TransactionFixtureError(failure.code, failure.message);
}

function cloneAttempt(attempt: TaggedWriteAttempt): TaggedWriteAttempt {
	return Object.freeze({ ...attempt });
}

function cloneSuccess(write: SuccessfulWrite): SuccessfulWrite {
	return Object.freeze({ ...write });
}

function cloneObservation(observation: ExemptPhysicalOutputObservation): ExemptPhysicalOutputObservation {
	return Object.freeze({ ...observation });
}

/**
 * A deterministic observer for shared renderer writes and separately classified
 * exempt output. It is intentionally useful without a real Terminal instance.
 */
export class HistoryTransactionFixture {
	readonly domainId: string;
	readonly attempts: readonly TaggedWriteAttempt[] = [];
	readonly successfulWrites: readonly SuccessfulWrite[] = [];
	readonly records: readonly HistoryTransactionRecord[] = [];
	readonly acceptedRecords: readonly HistoryTransactionRecord[] = [];
	readonly rejectedRecords: readonly HistoryTransactionRecord[] = [];
	readonly exemptPhysicalOutput: readonly ExemptPhysicalOutputObservation[] = [];

	#attempts: TaggedWriteAttempt[] = [];
	#successfulWrites: SuccessfulWrite[] = [];
	#records: HistoryTransactionRecord[] = [];
	#acceptedRecords: HistoryTransactionRecord[] = [];
	#rejectedRecords: HistoryTransactionRecord[] = [];
	#exemptPhysicalOutput: ExemptPhysicalOutputObservation[] = [];
	#state: HistoryStateSnapshot;
	#snapshotSource?: () => HistoryStateSnapshot;
	#ordinal = 0;
	#failAtAttempt?: number;
	#failNextOperation?: SharedTransactionOperation | "exempt" | "any";

	constructor(options: HistoryTransactionFixtureOptions = {}) {
		this.domainId = options.domainId ?? "history-fixture-domain";
		this.#state = freezeSnapshot(options.state ?? {});
		this.#snapshotSource = options.snapshot;
		this.syncViews();
	}

	private syncViews(): void {
		(this as { attempts: readonly TaggedWriteAttempt[] }).attempts = Object.freeze([...this.#attempts]);
		(this as { successfulWrites: readonly SuccessfulWrite[] }).successfulWrites = Object.freeze([
			...this.#successfulWrites,
		]);
		(this as { records: readonly HistoryTransactionRecord[] }).records = Object.freeze([...this.#records]);
		(this as { acceptedRecords: readonly HistoryTransactionRecord[] }).acceptedRecords = Object.freeze([
			...this.#acceptedRecords,
		]);
		(this as { rejectedRecords: readonly HistoryTransactionRecord[] }).rejectedRecords = Object.freeze([
			...this.#rejectedRecords,
		]);
		(this as { exemptPhysicalOutput: readonly ExemptPhysicalOutputObservation[] }).exemptPhysicalOutput =
			Object.freeze([...this.#exemptPhysicalOutput]);
	}

	get state(): HistoryStateSnapshot {
		return this.readSnapshot();
	}

	setState(state: HistoryStateInput): HistoryStateSnapshot {
		this.#state = freezeSnapshot(state);
		return this.#state;
	}

	updateState(update: HistoryStateInput): HistoryStateSnapshot {
		return this.setState({
			...this.#state,
			...update,
			cursor: { ...this.#state.cursor, ...update.cursor },
		});
	}

	readSnapshot(): HistoryStateSnapshot {
		const current = this.#snapshotSource?.() ?? this.#state;
		return freezeSnapshot(current);
	}

	failOnAttempt(ordinal: number): void {
		if (!Number.isInteger(ordinal) || ordinal < 1) {
			throw new RangeError("failure attempt ordinal must be a positive integer");
		}
		this.#failAtAttempt = ordinal;
	}

	failNext(operation?: SharedTransactionOperation | "exempt"): void {
		if (operation !== undefined && operation !== "exempt" && !isSharedOperation(operation)) {
			throw new TransactionFixtureError("invalid-operation", `unknown transaction operation: ${String(operation)}`);
		}
		this.#failNextOperation = operation ?? "any";
	}

	resetFailure(): void {
		this.#failAtAttempt = undefined;
		this.#failNextOperation = undefined;
	}

	rearm(): void {
		this.resetFailure();
	}

	reset(): void {
		this.#attempts = [];
		this.#successfulWrites = [];
		this.#records = [];
		this.#acceptedRecords = [];
		this.#rejectedRecords = [];
		this.#exemptPhysicalOutput = [];
		this.#ordinal = 0;
		this.resetFailure();
		this.syncViews();
	}

	private shouldInjectFailure(ordinal: number, operation: SharedTransactionOperation | "exempt"): boolean {
		if (this.#failAtAttempt === ordinal) {
			this.#failAtAttempt = undefined;
			return true;
		}
		if (this.#failNextOperation === operation || this.#failNextOperation === "any") {
			this.#failNextOperation = undefined;
			return true;
		}
		return false;
	}

	private appendAttempt(
		classification: TransactionClassification,
		operation: SharedTransactionOperation | undefined,
		bytes: string,
		outcome: TransactionOutcome,
		error?: string,
	): number {
		const ordinal = ++this.#ordinal;
		this.#attempts.push(
			cloneAttempt({ ordinal, classification, operation, bytes, outcome, error }),
		);
		return ordinal;
	}

	private appendSuccess(
		ordinal: number,
		classification: TransactionClassification,
		operation: SharedTransactionOperation | undefined,
		bytes: string,
	): void {
		this.#successfulWrites.push(cloneSuccess({ ordinal, classification, operation, bytes }));
	}

	/**
	 * Record and deliver one shared transaction. `apply` is the state mutation
	 * performed by the caller after validation; it is not called for rejection or
	 * injected delivery failure.
	 */
	record(
		operation: unknown,
		bytes: string,
		apply?: () => void,
	): HistoryTransactionRecord {
		const pre = this.readSnapshot();
		const validOperation = isSharedOperation(operation);
		const normalizedOperation = validOperation ? operation : undefined;
		const ordinal = this.appendAttempt(
			"shared",
			normalizedOperation,
			bytes,
			"rejected",
			validOperation ? undefined : `unknown transaction operation: ${String(operation)}`,
		);
		let error: TransactionFixtureError | undefined;
		if (!validOperation) {
			error = new TransactionFixtureError(
				"invalid-operation",
				`unknown transaction operation: ${String(operation)}`,
			);
		} else {
			try {
				assertSafeSharedTransaction(bytes);
				if (this.shouldInjectFailure(ordinal, operation)) {
					throw new TransactionFixtureError("injected-failure", `injected failure at attempt ${ordinal}`);
				}
				apply?.();
				this.#attempts[this.#attempts.length - 1] = cloneAttempt({
					...this.#attempts[this.#attempts.length - 1],
					outcome: "accepted",
				});
				const post = this.readSnapshot();
				const record = Object.freeze({
					domainId: this.domainId,
					operation,
					bytes,
					pre,
					post,
					outcome: "accepted" as const,
				});
				this.#records.push(record);
				this.#acceptedRecords.push(record);
				this.appendSuccess(ordinal, "shared", operation, bytes);
				this.syncViews();
				return record;
			} catch (caught) {
				error = caught instanceof TransactionFixtureError
					? caught
					: new TransactionFixtureError("injected-failure", String(caught));
			}
		}
		if (!error) {
			throw new Error("transaction rejection did not produce an error");
		}
		const message = error.message;
		this.#attempts[this.#attempts.length - 1] = cloneAttempt({
			...this.#attempts[this.#attempts.length - 1],
			outcome: error.code === "injected-failure" ? "failed" : "rejected",
			error: message,
		});
		const record = Object.freeze({
			domainId: this.domainId,
			operation: normalizedOperation,
			bytes,
			pre,
			post: pre,
			outcome: "rejected" as const,
			error: message,
		});
		this.#records.push(record);
		this.#rejectedRecords.push(record);
		this.syncViews();
		throw error;
	}

	commit(operation: unknown, bytes: string, apply?: () => void): HistoryTransactionRecord {
		return this.record(operation, bytes, apply);
	}

	/** Record an exempt physical write without ever adding a shared record. */
	writeExempt(bytes: string, apply?: () => void): void {
		const ordinal = this.appendAttempt("exempt", undefined, bytes, "failed");
		try {
			if (this.shouldInjectFailure(ordinal, "exempt")) {
				throw new TransactionFixtureError("injected-failure", `injected failure at attempt ${ordinal}`);
			}
			apply?.();
			this.#attempts[this.#attempts.length - 1] = cloneAttempt({
				...this.#attempts[this.#attempts.length - 1],
				outcome: "accepted",
			});
			this.appendSuccess(ordinal, "exempt", undefined, bytes);
			this.#exemptPhysicalOutput.push(cloneObservation({ ordinal, bytes, outcome: "accepted" }));
			this.syncViews();
		} catch (caught) {
			const error = caught instanceof Error ? caught : new Error(String(caught));
			this.#attempts[this.#attempts.length - 1] = cloneAttempt({
				...this.#attempts[this.#attempts.length - 1],
				outcome: "failed",
				error: error.message,
			});
			this.#exemptPhysicalOutput.push(
				cloneObservation({ ordinal, bytes, outcome: "failed", error: error.message }),
			);
			this.syncViews();
			throw error;
		}
	}
	observeExempt(bytes: string, apply?: () => void): void {
		this.writeExempt(bytes, apply);
	}

	/** An untagged shared write is observable but can never reach delivery. */
	write(bytes: string): never {
		const pre = this.readSnapshot();
		this.appendAttempt("shared", undefined, bytes, "rejected", "missing operation tag");
		const error = new TransactionFixtureError("invalid-operation", "missing transaction operation tag");
		this.#attempts[this.#attempts.length - 1] = cloneAttempt({
			...this.#attempts[this.#attempts.length - 1],
			error: error.message,
		});
		const record = Object.freeze({
			domainId: this.domainId,
			operation: undefined,
			bytes,
			pre,
			post: pre,
			outcome: "rejected" as const,
			error: error.message,
		});
		this.#records.push(record);
		this.#rejectedRecords.push(record);
		this.syncViews();
		throw error;
	}
}

/** Compatibility name used by terminal-boundary tests. */
export class HistoryRecordingTerminal extends HistoryTransactionFixture {
	readonly columns = 80;
	readonly rows = 24;
	readonly kittyProtocolActive = false;
	readonly isProcessTerminal = false;
	#available = true;

	get available(): boolean {
		return this.#available;
	}

	set available(value: boolean) {
		this.#available = value;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {
		this.#available = true;
	}

	stop(): void {
		this.#available = false;
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {
		throw new Error("clearLine is not a shared transaction operation");
	}
	clearFromCursor(): void {
		throw new Error("clearFromCursor is not a shared transaction operation");
	}
	clearScreen(): void {
		throw new Error("clearScreen is not a shared transaction operation");
	}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_callback: (appearance: "dark" | "light") => void): void {}
	get appearance(): "dark" | "light" | undefined {
		return undefined;
	}
}
