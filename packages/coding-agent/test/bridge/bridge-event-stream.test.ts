import { describe, expect, it } from "bun:test";
import { BridgeEventStream } from "../../src/modes/bridge/event-stream";
import { BRIDGE_PROTOCOL_VERSION, type BridgeFrameEnvelope } from "../../src/modes/shared/agent-wire/protocol";

function frame(seq: number, type = "event"): BridgeFrameEnvelope {
	return {
		protocol_version: BRIDGE_PROTOCOL_VERSION,
		session_id: "sess-1",
		seq,
		frame_id: `frame-${seq}`,
		type: type as BridgeFrameEnvelope["type"],
		payload: { seq },
	};
}

async function readChunk(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing response body");
	const chunk = await reader.read();
	await reader.cancel();
	if (!chunk.value) throw new Error("missing chunk");
	return new TextDecoder().decode(chunk.value);
}

describe("BridgeEventStream", () => {
	it("replays frames after last_seq", async () => {
		const stream = new BridgeEventStream();
		stream.publish(frame(1));
		stream.publish(frame(2));
		const text = await readChunk(stream.response(1));
		expect(text).toContain('"seq":2');
		expect(text).not.toContain('"seq":1');
	});

	it("publishes live frames to connected clients", async () => {
		const stream = new BridgeEventStream();
		const response = stream.response();
		stream.publish(frame(1));
		const text = await readChunk(response);
		expect(text).toContain("data: ");
		expect(text).toContain('"session_id":"sess-1"');
	});
	it("emits reset when requested cursor predates bounded replay window", async () => {
		const stream = new BridgeEventStream(1);
		stream.publish(frame(1));
		stream.publish(frame(2));
		stream.publish(frame(3));
		const text = await readChunk(stream.response(1));
		expect(text).toContain('"type":"reset"');
		expect(text).toContain('"first_seq":3');
	});
	it("drops a cancelled subscriber and keeps publishing to the rest", async () => {
		const stream = new BridgeEventStream();
		const first = stream.response();
		const second = stream.response();
		const firstReader = first.body?.getReader();
		const secondReader = second.body?.getReader();
		if (!firstReader || !secondReader) throw new Error("missing stream body");
		await firstReader.cancel();
		expect(() => stream.publish(frame(1))).not.toThrow();
		const chunk = await secondReader.read();
		await secondReader.cancel();
		if (!chunk.value) throw new Error("missing chunk");
		expect(new TextDecoder().decode(chunk.value)).toContain('"seq":1');
	});

	it("reset frame carries reason and seq one before first retained frame", async () => {
		const stream = new BridgeEventStream(1);
		stream.publish(frame(1));
		stream.publish(frame(2));
		stream.publish(frame(3));
		const text = await readChunk(stream.response(1));
		const reset = JSON.parse(text.slice("data: ".length).trim()) as {
			type: string;
			seq: number;
			payload: { reason: string; first_seq: number };
		};
		expect(reset.type).toBe("reset");
		expect(reset.payload.reason).toBe("replay_window_exceeded");
		expect(reset.payload.first_seq).toBe(3);
		expect(reset.seq).toBe(reset.payload.first_seq - 1);
	});
});
