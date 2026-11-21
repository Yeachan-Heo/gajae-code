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
import { type DesktopFrame, MAX_FRAME_BYTES } from "../src/protocol";

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

	for (const mode of ["success", "throw", "callback"] as const) {
		test(`preserves independently owned error listeners after ${mode}`, async () => {
			const failure = new Error("sink failed");
			const observed: Error[] = [];
			const observer = (error: Error) => observed.push(error);
			const output = new stream.Writable({
				write(_chunk, _encoding, callback) {
					if (mode === "throw") throw failure;
					callback(mode === "callback" ? failure : undefined);
				},
			});
			output.on("error", observer);
			try {
				const result = createWritableFrameSink(output)(Buffer.from("frame"));
				if (mode === "success") await result;
				else await expect(result).rejects.toBe(failure);
				await Bun.sleep(0);
				expect(output.listeners("error")).toEqual([observer]);
				expect(observed).toEqual(mode === "callback" ? [failure] : []);
			} finally {
				output.removeListener("error", observer);
			}
		});
	}

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
		const frame: DesktopFrame = { type: "response", id: "large", ok: true, result: "gajae🙂".repeat(10_000) };
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

	test("an oversized response immediately retires admission and permits only a bounded fatal", async () => {
		const written: string[] = [];
		const errors: unknown[] = [];
		const writer = createFrameWriter({
			write: async bytes => {
				written.push(Buffer.from(bytes).toString());
			},
			onError: error => errors.push(error),
		});
		writer.write({ type: "response", id: "oversized", ok: true, result: "x".repeat(MAX_FRAME_BYTES) });
		expect(writer.failed).toBe(true);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(Error);
		writer.write({ type: "response", id: "same-chunk", ok: true, result: null });
		await writer.flush();
		expect(written).toEqual([`${JSON.stringify({ type: "fatal", error: "Response exceeds frame limit" })}\n`]);
		writer.write({ type: "response", id: "after-flush", ok: true, result: null });
		await writer.flush();
		expect(written).toHaveLength(1);
		expect(errors).toHaveLength(1);
	});

	test("does not exceed the backlog to send an oversized response's terminal fatal", async () => {
		const written: Uint8Array[] = [];
		const errors: unknown[] = [];
		const writer = createFrameWriter({
			write: async bytes => {
				written.push(bytes);
			},
			maxBacklogBytes: 1,
			onError: error => errors.push(error),
		});
		writer.write({ type: "response", id: "oversized", ok: true, result: "x".repeat(MAX_FRAME_BYTES) });
		writer.write({ type: "response", id: "same-chunk", ok: true, result: null });
		await writer.flush();
		expect(writer.failed).toBe(true);
		expect(errors).toHaveLength(1);
		expect(written).toEqual([]);
	});

	test("fails closed when a snapshot cannot be serialized", async () => {
		const written: Uint8Array[] = [];
		const errors: unknown[] = [];
		const writer = createFrameWriter({
			write: async bytes => {
				written.push(bytes);
			},
			onError: error => errors.push(error),
		});
		const snapshot: Record<string, unknown> = {};
		snapshot.self = snapshot;
		writer.write({ type: "snapshot", snapshot } as unknown as DesktopFrame);
		expect(writer.failed).toBe(true);
		writer.write({ type: "response", id: "after-snapshot", ok: true, result: null });
		await writer.flush();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(TypeError);
		expect(written).toEqual([]);
	});

	test("surfaces a throwing error observer through flush without rejecting the queue tail", async () => {
		const sinkFailure = new Error("sink failed");
		const observerFailure = new Error("error observer failed");
		const errors: unknown[] = [];
		const writer = createFrameWriter({
			write: async () => {
				throw sinkFailure;
			},
			onError: error => {
				errors.push(error);
				throw observerFailure;
			},
		});
		writer.write({ type: "response", id: "1", ok: true, result: null });
		writer.write({ type: "response", id: "2", ok: true, result: null });
		await expect(writer.flush()).rejects.toBe(observerFailure);
		await Bun.sleep(0);
		await expect(writer.flush()).rejects.toBe(observerFailure);
		expect(writer.failed).toBe(true);
		expect(errors).toEqual([sinkFailure]);
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

	for (const lateFailure of [false, true]) {
		test(`overflow releases an existing flush before a stalled write ${lateFailure ? "fails" : "succeeds"}`, async () => {
			const errors: unknown[] = [];
			const written: string[] = [];
			const pending = Promise.withResolvers<(error?: Error | null) => void>();
			const output = new stream.Writable({
				write(chunk, _encoding, callback) {
					written.push(chunk.toString());
					pending.resolve(callback);
				},
			});
			const writer = createFrameWriter({
				write: createWritableFrameSink(output),
				maxBacklogBytes: 256,
				onError: error => errors.push(error),
			});
			const first: DesktopFrame = { type: "response", id: "active", ok: true, result: null };
			writer.write(first);
			const callback = await pending.promise;
			let released = false;
			try {
				writer.write({ type: "response", id: "queued", ok: true, result: null });
				let flushed = false;
				const flushing = writer.flush().then(() => {
					flushed = true;
				});
				await Promise.resolve();
				expect(flushed).toBe(false);
				writer.write({ type: "response", id: "overflow", ok: true, result: "x".repeat(256) });
				expect(writer.failed).toBe(true);
				expect(errors).toHaveLength(1);
				// This must settle before the held callback is released, without a
				// subsequent write being needed to wake the failure signal.
				await flushing;
				expect(flushed).toBe(true);
				expect(written).toEqual([`${JSON.stringify(first)}\n`]);
				writer.write({ type: "response", id: "after-failure", ok: true, result: null });
				released = true;
				callback(lateFailure ? new Error("late sink failure") : undefined);
				// Let the callback/error-event pair and the observed queue tail run.
				// An unhandled late rejection must still fail the test runner.
				await Bun.sleep(0);
				await writer.flush();
				expect(written).toEqual([`${JSON.stringify(first)}\n`]);
				expect(errors).toHaveLength(1);
				expect(output.listenerCount("error")).toBe(0);
			} finally {
				if (!released) callback();
			}
		});
	}

	test("normal flush waits for every queued write callback", async () => {
		const callbacks: ((error?: Error | null) => void)[] = [];
		const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const output = new stream.Writable({
			write(_chunk, _encoding, callback) {
				callbacks.push(callback);
				started[callbacks.length - 1]!.resolve();
			},
		});
		const writer = createFrameWriter({ write: createWritableFrameSink(output) });
		writer.write({ type: "response", id: "1", ok: true, result: null });
		writer.write({ type: "response", id: "2", ok: true, result: null });
		let flushed = false;
		const flushing = writer.flush().then(() => {
			flushed = true;
		});
		await started[0]!.promise;
		expect(flushed).toBe(false);
		expect(callbacks).toHaveLength(1);
		callbacks[0]!();
		await started[1]!.promise;
		expect(flushed).toBe(false);
		callbacks[1]!();
		await flushing;
		expect(flushed).toBe(true);
		expect(writer.failed).toBe(false);
	});
});
