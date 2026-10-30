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
import * as crypto from "node:crypto";
import * as stream from "node:stream";
import { createFrameWriter, createWritableFrameSink } from "../src/frame-writer";
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

describe("writable frame sink", () => {
	test("captures the original write before diagnostics are redirected", async () => {
		const frames: string[] = [];
		const diagnostics: string[] = [];
		const output = new stream.Writable({
			write(chunk, _encoding, callback) {
				frames.push(chunk.toString());
				callback();
			},
		});
		const redirect = new stream.Writable({
			write(chunk, _encoding, callback) {
				diagnostics.push(chunk.toString());
				callback();
			},
		});
		const sink = createWritableFrameSink(output);
		output.write = redirect.write.bind(redirect);
		output.write("diagnostic");
		await sink(Buffer.from("frame"));
		expect(frames).toEqual(["frame"]);
		expect(diagnostics).toEqual(["diagnostic"]);
		expect(output.listenerCount("error")).toBe(0);
	});

	test("waits for the write callback before resolving", async () => {
		const pending = Promise.withResolvers<(error?: Error | null) => void>();
		const output = new stream.Writable({
			write(_chunk, _encoding, callback) {
				pending.resolve(callback);
			},
		});
		let resolved = false;
		const result = createWritableFrameSink(output)(Buffer.from("frame")).then(() => {
			resolved = true;
		});
		const callback = await pending.promise;
		expect(resolved).toBe(false);
		callback();
		await result;
		expect(resolved).toBe(true);
		expect(output.listenerCount("error")).toBe(0);
	});

	test("rejects a write callback error and consumes its subsequent error event", async () => {
		const failure = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
		const output = new stream.Writable({
			write(_chunk, _encoding, callback) {
				callback(failure);
			},
		});
		// No observer listener may mask an unhandled error after the write callback.
		await expect(createWritableFrameSink(output)(Buffer.from("frame"))).rejects.toBe(failure);
		await Bun.sleep(0);
		expect(output.listenerCount("error")).toBe(0);
	});

	test("rejects a thrown write and removes its listener", async () => {
		const failure = new Error("write threw");
		const output = new stream.Writable({
			write() {
				throw failure;
			},
		});
		await expect(createWritableFrameSink(output)(Buffer.from("frame"))).rejects.toBe(failure);
		expect(output.listenerCount("error")).toBe(0);
	});

	test("rejects an error event before the write callback", async () => {
		const pending = Promise.withResolvers<(error?: Error | null) => void>();
		const output = new stream.Writable({
			write(_chunk, _encoding, callback) {
				pending.resolve(callback);
			},
		});
		const failure = new Error("stream failed");
		const result = createWritableFrameSink(output)(Buffer.from("frame"));
		const rejected = result.catch((error: unknown) => error);
		const callback = await pending.promise;
		output.emit("error", failure);
		callback();
		expect(await rejected).toBe(failure);
		expect(output.listenerCount("error")).toBe(0);
	});
});

describe("frame writer", () => {
	test("delivers a frame larger than a pipe buffer without splitting it", async () => {
		const chunks: Uint8Array[] = [];
		const writer = createFrameWriter({ write: sinkThatChunks(chunks, 0) });
		const frame: DesktopFrame = { type: "response", id: "large", ok: true, result: "한글🙂".repeat(10_000) };
		const expected = Buffer.from(`${JSON.stringify(frame)}\n`);
		expect(expected.length).toBeGreaterThan(64 * 1024);
		writer.write(frame);
		await writer.flush();

		const joined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
		expect(joined.equals(expected)).toBe(true);
		expect(writer.failed).toBe(false);
	});

	test("preserves mixed UTF-8 frames through a slow subprocess pipe", async () => {
		const sizes = [14, 28, 34, 56, 67];
		const expected = crypto.createHash("sha256");
		let expectedBytes = 0;
		for (let i = 0; i < 200; i++) {
			const frame = {
				type: "response",
				id: String(i),
				ok: true,
				result: "🙂".repeat((sizes[i % sizes.length]! * 1024) / 4),
			};
			const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
			expected.update(bytes);
			expectedBytes += bytes.length;
		}
		const moduleUrl = new URL("../src/frame-writer.ts", import.meta.url).href;
		const script = `
			import { createFrameWriter, createWritableFrameSink } from ${JSON.stringify(moduleUrl)};
			const write = createWritableFrameSink(process.stdout);
			process.stdout.write = process.stderr.write.bind(process.stderr);
			process.stdout.write("redirected diagnostic\\n");
			const writer = createFrameWriter({ write, onError: error => { console.error(error); process.exitCode = 1; } });
			const sizes = [14, 28, 34, 56, 67];
			for (let i = 0; i < 200; i++) {
				writer.write({ type: "response", id: String(i), ok: true, result: "🙂".repeat(sizes[i % sizes.length] * 1024 / 4) });
			}
			await writer.flush();
		`;
		const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
		const stderr = new Response(child.stderr).text();
		const reader = child.stdout.getReader();
		const watchdog = setTimeout(() => child.kill(), 40_000);
		try {
			const actual = crypto.createHash("sha256");
			let actualBytes = 0;
			await Bun.sleep(100);
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				actual.update(chunk.value);
				actualBytes += chunk.value.length;
				await Bun.sleep(10);
			}
			const exitCode = await child.exited;
			const diagnostic = await stderr;
			expect(exitCode).toBe(0);
			expect(diagnostic).toBe("redirected diagnostic\n");
			expect(actualBytes).toBe(expectedBytes);
			expect(actual.digest("hex")).toBe(expected.digest("hex"));
		} finally {
			clearTimeout(watchdog);
			if (child.exitCode === null) child.kill();
			await reader.cancel();
			await child.exited;
			await stderr;
		}
	}, 45_000);

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
		const blocked = Promise.withResolvers<void>();
		const writer = createFrameWriter({
			write: () => blocked.promise,
			maxBacklogBytes: 1024,
			onError: error => errors.push(error),
		});
		writer.write({ type: "snapshot", snapshot: { blob: "x".repeat(2048) } } as unknown as DesktopFrame);
		writer.write({ type: "snapshot", snapshot: { blob: "y".repeat(2048) } } as unknown as DesktopFrame);

		expect(writer.failed).toBe(true);
		expect(errors).toHaveLength(1);
		blocked.resolve();
		await writer.flush();
	});
});
