/**
 * Frame writer behaviour on a slow/partial sink.
 *
 * The desktop parent reads the engine's stdout pipe in 8 KiB chunks and can lag
 * behind a large snapshot. A writer that hands a frame to the OS in one call and
 * gives up on a short write truncates the frame at the pipe boundary (64 KiB on
 * macOS), which the app reports as invalid JSON. These tests pin the properties
 * that prevent it: frames are written whole, in order, and a failed channel is
 * reported instead of silently corrupting the stream.
 */
import { describe, expect, test } from "bun:test";
import { createFrameWriter } from "../src/frame-writer";
import type { DesktopFrame } from "../src/protocol";

function sinkThatChunks(chunks: Uint8Array[], delayMs = 0) {
	return async (bytes: Uint8Array) => {
		// Mimic a pipe that accepts at most 8 KiB per write.
		for (let offset = 0; offset < bytes.length; offset += 8192) {
			chunks.push(bytes.slice(offset, Math.min(offset + 8192, bytes.length)));
			if (delayMs > 0) await Bun.sleep(delayMs);
		}
	};
}

describe("frame writer", () => {
	test("delivers a frame larger than a pipe buffer without splitting it", async () => {
		const chunks: Uint8Array[] = [];
		const writer = createFrameWriter({ write: sinkThatChunks(chunks, 0) });
		const frame: DesktopFrame = {
			type: "snapshot",
			snapshot: {
				protocolVersion: 1,
				projects: [],
				sessions: [],
				capabilities: [],
				models: [],
			},
		} as unknown as DesktopFrame;
		writer.write(frame);
		await writer.flush();

		const joined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString();
		expect(joined.endsWith("\n")).toBe(true);
		const lines = joined.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual(JSON.parse(JSON.stringify(frame)));
		expect(writer.failed).toBe(false);
	});

	test("keeps frame order when the sink is slow", async () => {
		const written: string[] = [];
		const writer = createFrameWriter({
			write: async bytes => {
				await Bun.sleep(2);
				written.push(Buffer.from(bytes).toString());
			},
		});
		const frames: DesktopFrame[] = [
			{ type: "response", id: "1", ok: true, result: null },
			{ type: "response", id: "2", ok: true, result: null },
			{ type: "fatal", error: "boom" },
		] as DesktopFrame[];
		for (const frame of frames) writer.write(frame);
		await writer.flush();

		expect(written).toEqual(frames.map(frame => `${JSON.stringify(frame)}\n`));
	});

	test("reports a dead channel instead of writing a partial frame", async () => {
		const errors: unknown[] = [];
		let calls = 0;
		const writer = createFrameWriter({
			write: async () => {
				calls += 1;
				throw Object.assign(new Error("EAGAIN: resource temporarily unavailable, write"), { code: "EAGAIN" });
			},
			onError: error => errors.push(error),
		});
		writer.write({ type: "response", id: "1", ok: true, result: null } as DesktopFrame);
		writer.write({ type: "response", id: "2", ok: true, result: null } as DesktopFrame);
		await writer.flush();

		expect(calls).toBe(1);
		expect(writer.failed).toBe(true);
		expect(errors).toHaveLength(1);
	});

	test("gives up when the parent stops draining", async () => {
		const errors: unknown[] = [];
		let release = () => {};
		const blocked = new Promise<void>(resolve => {
			release = resolve;
		});
		const writer = createFrameWriter({
			write: () => blocked,
			maxBacklogBytes: 1024,
			onError: error => errors.push(error),
		});
		writer.write({ type: "snapshot", snapshot: { blob: "x".repeat(2048) } } as unknown as DesktopFrame);
		writer.write({ type: "snapshot", snapshot: { blob: "y".repeat(2048) } } as unknown as DesktopFrame);

		expect(writer.failed).toBe(true);
		expect(errors).toHaveLength(1);
		release();
		await writer.flush();
	});
});
