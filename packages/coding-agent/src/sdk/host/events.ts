import type { SdkFrame } from "./types";

export interface EventFrame extends SdkFrame {
	type: "event";
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

export class SessionEventStream {
	#generation = 0;
	#seq = 0;
	#frames: EventFrame[] = [];
	readonly #ringSize: number;
	readonly #resyncQueries: string[];

	constructor(options: { generation?: number; ringSize?: number; resyncQueryIds?: string[] } = {}) {
		this.#generation = options.generation ?? 0;
		this.#ringSize = options.ringSize ?? 256;
		this.#resyncQueries = options.resyncQueryIds ?? ["Q01", "Q02", "Q03"];
	}

	get generation(): number {
		return this.#generation;
	}
	get sequence(): number {
		return this.#seq;
	}

	restart(): number {
		this.#generation += 1;
		this.#seq = 0;
		this.#frames = [];
		return this.#generation;
	}

	emit(frame: SdkFrame): EventFrame {
		const event: EventFrame = { ...frame, type: "event", generation: this.#generation, seq: ++this.#seq };
		this.#frames.push(event);
		if (this.#frames.length > this.#ringSize) this.#frames.shift();
		return event;
	}

	/** Replays retained current-generation events and reports any required resynchronization. */
	replay(lastSeq: number, generation = this.#generation): EventReplay {
		const events = this.#frames.filter(frame => frame.seq > lastSeq);
		if (generation !== this.#generation) {
			return {
				events: [...this.#frames],
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
				events: this.#frames.filter(frame => frame.seq >= oldest),
				gap: {
					kind: "sequence_gap",
					fromSeq: replayFrom,
					toSeq: oldest - 1,
					resyncQueries: [...this.#resyncQueries],
				},
			};
		}
		return { events };
	}
}
