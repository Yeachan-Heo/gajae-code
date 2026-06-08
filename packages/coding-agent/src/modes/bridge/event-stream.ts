import type { BridgeFrameEnvelope } from "../shared/agent-wire/protocol";

const encoder = new TextEncoder();
const DEFAULT_REPLAY_LIMIT = 1_000;

function encodeSseFrame(frame: BridgeFrameEnvelope): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
}

export class BridgeEventStream {
	#frames: BridgeFrameEnvelope[] = [];
	#subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
	#replayLimit: number;

	constructor(replayLimit = DEFAULT_REPLAY_LIMIT) {
		this.#replayLimit = replayLimit;
	}
	get frameCount(): number {
		return this.#frames.length;
	}

	publish(frame: BridgeFrameEnvelope): void {
		this.#frames.push(frame);
		if (this.#frames.length > this.#replayLimit) this.#frames.splice(0, this.#frames.length - this.#replayLimit);
		const encoded = encodeSseFrame(frame);
		for (const controller of this.#subscribers) {
			try {
				controller.enqueue(encoded);
			} catch {
				this.#subscribers.delete(controller);
			}
		}
	}

	response(lastSeq = 0): Response {
		let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start: controller => {
				streamController = controller;
				const first = this.#frames[0];
				if (first && lastSeq > 0 && first.seq > lastSeq + 1) {
					controller.enqueue(
						encodeSseFrame({
							protocol_version: first.protocol_version,
							session_id: first.session_id,
							seq: first.seq - 1,
							frame_id: `reset-${first.seq}`,
							type: "reset",
							payload: { reason: "replay_window_exceeded", first_seq: first.seq },
						}),
					);
				}
				for (const frame of this.#frames) {
					if (frame.seq > lastSeq) controller.enqueue(encodeSseFrame(frame));
				}
				this.#subscribers.add(controller);
			},
			cancel: () => {
				if (streamController) this.#subscribers.delete(streamController);
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}
}
