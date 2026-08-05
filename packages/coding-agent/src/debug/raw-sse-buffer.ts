import type { Model, ProviderResponseMetadata, RawSseEvent } from "@gajae-code/ai/core";

const MAX_RAW_SSE_EVENTS = 1_000;
const MAX_RAW_SSE_CHARS = 512_000;
const MAX_RAW_SSE_EVENT_CHARS = 64_000;

export type RawSseDebugRecord =
	| {
			kind: "response";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			status: number;
			requestId?: string | null;
			transport?: string;
	  }
	| {
			kind: "event";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			event: string | null;
			raw: string[];
			truncated: boolean;
			originalChars: number;
	  };

export interface RawSseDebugSnapshot {
	records: readonly RawSseDebugRecord[];
	droppedRecords: number;
	droppedChars: number;
	totalEvents: number;
	lastUpdatedAt?: number;
}

// Per-record char counts are stored in a parallel array (`#recordChars`) on
// the buffer rather than stamped onto each record via a symbol property.
// Stamping triggered hidden-class transitions in V8/JSC — the previous
// revision saw `trimRawLines` regress 4× (0.5s → 2.0s in a 50s profile)
// because every event-record allocation went through the slow dictionary
// path. The parallel array keeps records as plain monomorphic objects.
type TrimResult = { raw: string[]; truncated: boolean; originalChars: number; chars: number };

// Single-pass trim. Returns the final `chars` count using the historical
// formula `reduce(line.length + 1, init = 1)` so the new accounting matches
// the previous `countRecordChars` byte-for-byte (the trailing +1 covers the
// record-level newline that `rawRecordText` appends in `toRawText`).
//
// When the event fits within budget the input `raw` array is returned
// **by reference** — see the ownership contract documented at
// `RawSseDebugBuffer.recordEvent` below.
function trimRawLines(raw: string[]): TrimResult {
	let originalChars = 0;
	for (let i = 0; i < raw.length; i++) originalChars += raw[i].length + 1;

	if (originalChars <= MAX_RAW_SSE_EVENT_CHARS) {
		return { raw, truncated: false, originalChars, chars: originalChars + 1 };
	}

	const trimmed: string[] = [];
	let remaining = MAX_RAW_SSE_EVENT_CHARS;
	let chars = 1; // matches reduce(.., init = 1)
	for (const line of raw) {
		if (remaining <= 0) break;
		if (line.length + 1 <= remaining) {
			trimmed.push(line);
			chars += line.length + 1;
			remaining -= line.length + 1;
			continue;
		}
		const slice = line.slice(0, Math.max(0, remaining));
		trimmed.push(slice);
		chars += slice.length + 1;
		remaining = 0;
	}
	const tail = `: gjc-debug-truncated originalChars=${originalChars}`;
	trimmed.push(tail);
	chars += tail.length + 1;
	return { raw: trimmed, truncated: true, originalChars, chars };
}

export function formatRawSseIsoTime(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

export function formatRawSseResponseComment(record: Extract<RawSseDebugRecord, { kind: "response" }>): string {
	const fields = [
		"gjc-response",
		`ts=${formatRawSseIsoTime(record.timestamp)}`,
		`status=${record.status}`,
		record.provider ? `provider=${record.provider}` : undefined,
		record.model ? `model=${record.model}` : undefined,
		record.api ? `api=${record.api}` : undefined,
		record.requestId ? `requestId=${record.requestId}` : undefined,
		record.transport ? `transport=${record.transport}` : undefined,
	].filter((field): field is string => field !== undefined);
	return `: ${fields.join(" ")}`;
}

export function rawSseRecordLines(record: RawSseDebugRecord): string[] {
	if (record.kind === "response") return [formatRawSseResponseComment(record)];
	return record.raw;
}

function rawRecordText(record: RawSseDebugRecord): string {
	return `${rawSseRecordLines(record).join("\n")}\n`;
}

function metadataTransport(response: ProviderResponseMetadata): string | undefined {
	const value = response.metadata?.lastTransport;
	return typeof value === "string" ? value : undefined;
}

export class RawSseDebugBuffer {
	#records: RawSseDebugRecord[] = [];
	// Parallel to `#records`: `#recordChars[i]` is the precomputed char count
	// for `#records[i]`. Kept in lockstep by `#append` (push both) and
	// `#enforceLimits` (shift both). See the comment above the class for why
	// this is a sidecar array instead of a per-record property.
	#recordChars: number[] = [];
	#totalChars = 0;
	#droppedRecords = 0;
	#droppedChars = 0;
	#totalEvents = 0;
	#lastUpdatedAt: number | undefined;
	#nextSequence = 1;
	#listeners = new Set<() => void>();
	#emitScheduled = false;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	recordResponse(response: ProviderResponseMetadata, model?: Model): void {
		const record: RawSseDebugRecord = {
			kind: "response",
			sequence: this.#nextSequence++,
			timestamp: Date.now(),
			provider: model?.provider,
			model: model?.id,
			api: model?.api,
			status: response.status,
			requestId: response.requestId,
			transport: metadataTransport(response),
		};
		this.#append(record, formatRawSseResponseComment(record).length + 1);
	}

	// Ownership contract for `event.raw`:
	//   The caller (either `notifyRawSseEvent` in `packages/ai/src/utils/sse-debug.ts`
	//   or `SseTeeParser.#dispatch` directly) hands us a freshly-allocated
	//   `string[]` per event and never retains, mutates, or re-dispatches it.
	//   That lets `trimRawLines` keep the array by reference instead of
	//   cloning on every chunk — a measurable savings on the streaming hot
	//   path. If a future observer-chain mutates the array, restore the
	//   `raw.slice()` defensive copy inside `trimRawLines`.
	recordEvent(event: RawSseEvent, model?: Model): void {
		const trimmed = trimRawLines(event.raw);
		this.#totalEvents += 1;
		this.#append(
			{
				kind: "event",
				sequence: this.#nextSequence++,
				timestamp: Date.now(),
				provider: model?.provider,
				model: model?.id,
				api: model?.api,
				event: event.event,
				raw: trimmed.raw,
				truncated: trimmed.truncated,
				originalChars: trimmed.originalChars,
			},
			trimmed.chars,
		);
	}

	snapshot(): RawSseDebugSnapshot {
		return {
			records: [...this.#records],
			droppedRecords: this.#droppedRecords,
			droppedChars: this.#droppedChars,
			totalEvents: this.#totalEvents,
			lastUpdatedAt: this.#lastUpdatedAt,
		};
	}

	toRawText(): string {
		// Reads the live array directly: `rawRecordText` only computes a string
		// from each record, so no caller-visible mutation is possible.
		return this.#records.map(rawRecordText).join("\n");
	}

	#append(record: RawSseDebugRecord, chars: number): void {
		this.#records.push(record);
		this.#recordChars.push(chars);
		this.#totalChars += chars;
		this.#lastUpdatedAt = record.timestamp;
		this.#enforceLimits();
		this.#emit();
	}

	#enforceLimits(): void {
		while (this.#records.length > MAX_RAW_SSE_EVENTS || this.#totalChars > MAX_RAW_SSE_CHARS) {
			if (this.#records.length === 0) return;
			this.#records.shift();
			const chars = this.#recordChars.shift() ?? 0;
			this.#totalChars = Math.max(0, this.#totalChars - chars);
			this.#droppedRecords += 1;
			this.#droppedChars += chars;
		}
	}

	#emit(): void {
		const count = this.#listeners.size;
		if (count === 0) return;
		// With a single listener (the common case — RawSse debug viewer is the
		// only subscriber), keep eager emit so per-event semantics are
		// preserved. With multiple listeners, coalesce bursts of events into
		// one microtask-deferred fan-out to avoid N×M listener invocations
		// during a streaming response.
		if (count === 1) {
			this.#fanOut();
			return;
		}
		if (this.#emitScheduled) return;
		this.#emitScheduled = true;
		queueMicrotask(() => {
			this.#emitScheduled = false;
			this.#fanOut();
		});
	}

	#fanOut(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// Debug viewers must not be able to break stream capture.
			}
		}
	}
}

const globalFallbackBuffer = new RawSseDebugBuffer();
const kRawSseDebugBuffer = Symbol("debug.rawSseBuffer");
type OwnerWithBuffer = object & { rawSseDebugBuffer?: unknown; [kRawSseDebugBuffer]?: RawSseDebugBuffer };

export function resolveRawSseDebugBuffer(owner?: object): RawSseDebugBuffer {
	if (!owner) return globalFallbackBuffer;

	const tagged = owner as OwnerWithBuffer;
	const declared = tagged.rawSseDebugBuffer;
	if (declared instanceof RawSseDebugBuffer) return declared;

	const existing = tagged[kRawSseDebugBuffer];
	if (existing) return existing;

	const buffer = new RawSseDebugBuffer();
	try {
		tagged[kRawSseDebugBuffer] = buffer;
	} catch {
		// Non-extensible owner: caller gets a fresh buffer on each call.
	}
	return buffer;
}
