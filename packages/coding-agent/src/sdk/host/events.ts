import type { SdkFrame } from "./types";

export interface EventFrame extends SdkFrame {
	type: "event";
	revision?: number;
	generation: number;
	seq: number;
}

export type EventReplayGap =
	| {
			kind: "generation_reset";
			fromGeneration: number;
			toGeneration: number;
			resyncQueries: string[];
	  }
	| {
			kind: "sequence_gap";
			fromSeq: number;
			toSeq: number;
			resyncQueries: string[];
	  };

export interface EventReplay {
	events: EventFrame[];
	gap?: EventReplayGap;
}

/** Kinds emit sites suppress once notification redaction is on. */
const REDACTED_REPLAY_KINDS: ReadonlySet<string> = new Set([
	"turn_stream",
	"context_update",
	"image_attachment",
	"file_attachment",
	"reasoning_summary",
	"tool_activity",
]);

const outboundRedactBySession = new Map<string, boolean>();

/** Notification policy refresh records the live redaction bit for one session ring. */
export function setSessionOutboundRedact(sessionId: string, enabled: boolean): void {
	outboundRedactBySession.set(sessionId, enabled);
}

function frameSessionId(frame: SdkFrame): string | undefined {
	if (typeof frame.sessionId === "string") return frame.sessionId;
	const payload = frame.payload;
	if (!payload || typeof payload !== "object") return undefined;
	const sessionId = (payload as { sessionId?: unknown }).sessionId;
	return typeof sessionId === "string" ? sessionId : undefined;
}

export class SessionEventStream {
	#generation = 0;
	#seq = 0;
	#frames: EventFrame[] = [];
	#outboundRedact = false;
	#sessionId: string | undefined;
	readonly #ringSize: number;
	readonly #resyncQueries: string[];
	readonly #revisionProvider: (() => number | undefined) | undefined;

	constructor(
		options: {
			generation?: number;
			ringSize?: number;
			resyncQueryIds?: string[];
			revisionProvider?: () => number | undefined;
		} = {},
	) {
		this.#generation = options.generation ?? 0;
		this.#ringSize = options.ringSize ?? 256;
		this.#resyncQueries = options.resyncQueryIds ?? ["Q01", "Q02", "Q03"];
		this.#revisionProvider = options.revisionProvider;
	}

	get generation(): number {
		return this.#generation;
	}
	get sequence(): number {
		return this.#seq;
	}

	/** Follow the session redaction bit. Replay then drops kinds emit sites already suppress. */
	setOutboundRedact(enabled: boolean): void {
		this.#outboundRedact = enabled;
		if (this.#sessionId !== undefined) outboundRedactBySession.set(this.#sessionId, enabled);
	}

	/**
	 * Open the next event namespace. `floor` lets the owning host keep namespaces
	 * distinct across host instances of one session; within one stream the
	 * generation still only advances.
	 */
	restart(floor = 0): number {
		if (!Number.isSafeInteger(floor)) throw new Error("SDK event generation floor must be a safe integer.");
		const next = Math.max(this.#generation + 1, floor);
		if (!Number.isSafeInteger(next)) throw new Error("SDK event generation is exhausted.");
		this.#generation = next;
		this.#seq = 0;
		this.#frames = [];
		return this.#generation;
	}

	emit(frame: SdkFrame): EventFrame {
		this.#noteSession(frame);
		this.#noteConfigRedact(frame);
		const suppliedRevision = frame.revision;
		const providedRevision = this.#revisionProvider?.();
		const revision =
			typeof suppliedRevision === "number" && Number.isSafeInteger(suppliedRevision) && suppliedRevision >= 0
				? suppliedRevision
				: typeof providedRevision === "number" && Number.isSafeInteger(providedRevision) && providedRevision >= 0
					? providedRevision
					: undefined;
		const event: EventFrame = {
			...frame,
			type: "event",
			...(revision === undefined ? {} : { revision }),
			generation: this.#generation,
			seq: ++this.#seq,
		};
		this.#frames.push(event);
		if (this.#frames.length > this.#ringSize) this.#frames.shift();
		return event;
	}

	/** Replays retained current-generation events and reports any required resynchronization. */
	replay(lastSeq: number, generation = this.#generation): EventReplay {
		if (generation !== this.#generation) {
			return {
				events: this.#visible(this.#frames),
				gap: {
					kind: "generation_reset",
					fromGeneration: generation,
					toGeneration: this.#generation,
					resyncQueries: [...this.#resyncQueries],
				},
			};
		}
		const oldest = this.#frames[0]?.seq ?? this.#seq + 1;
		const replayFrom = lastSeq + 1;
		if (replayFrom < oldest) {
			return {
				events: this.#visible(this.#frames.filter(frame => frame.seq >= oldest)),
				gap: {
					kind: "sequence_gap",
					fromSeq: replayFrom,
					toSeq: oldest - 1,
					resyncQueries: [...this.#resyncQueries],
				},
			};
		}
		return { events: this.#visible(this.#frames.filter(frame => frame.seq > lastSeq)) };
	}

	#noteSession(frame: SdkFrame): void {
		if (this.#sessionId !== undefined) return;
		this.#sessionId = frameSessionId(frame);
	}

	#noteConfigRedact(frame: SdkFrame): void {
		if (frame.kind !== "config_update") return;
		const payload = frame.payload;
		if (!payload || typeof payload !== "object") return;
		const redact = (payload as { redact?: unknown }).redact;
		if (typeof redact !== "boolean") return;
		this.setOutboundRedact(redact);
	}

	#replayRedact(): boolean {
		if (this.#sessionId !== undefined) {
			const noted = outboundRedactBySession.get(this.#sessionId);
			if (noted !== undefined) return noted;
		}
		return this.#outboundRedact;
	}

	#visible(frames: readonly EventFrame[]): EventFrame[] {
		const retained = this.#replayRedact()
			? frames.filter(frame => !REDACTED_REPLAY_KINDS.has(String(frame.kind)))
			: frames;
		return [...retained];
	}
}
