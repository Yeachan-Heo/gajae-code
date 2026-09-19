import { expect, test } from "bun:test";
import * as events from "node:events";
import type * as http2 from "node:http2";
import { waitForCursorWritesForTest, writeCursorFrameForTest } from "../src/providers/cursor";

function writer(writable = true) {
	const callbacks: ((error?: Error | null) => void)[] = [];
	const emitter = Object.assign(new events.EventEmitter(), {
		closed: false,
		destroyed: false,
		writableEnded: false,
		writableFinished: false,
		write(_frame: Uint8Array, callback: (error?: Error | null) => void) {
			callbacks.push(callback);
			return writable;
		},
		close() {
			this.closed = true;
			emitter.emit("close");
		},
		destroy() {
			this.destroyed = true;
		},
	});
	return { request: emitter as unknown as http2.ClientHttp2Stream, callbacks };
}

test("shares bounded transport listeners across pending frames and preserves provider listeners", async () => {
	const { request, callbacks } = writer();
	const providerError = () => {};
	const providerClose = () => {};
	request.on("error", providerError);
	request.on("close", providerClose);
	for (let i = 0; i < 12; i++) expect(writeCursorFrameForTest(request, Buffer.from("frame"))).toBe(true);
	try {
		expect(request.listenerCount("error")).toBe(2);
		expect(request.listenerCount("close")).toBe(2);
		callbacks[0]();
		expect(request.listenerCount("error")).toBe(2);
	} finally {
		for (const callback of callbacks) callback();
		await waitForCursorWritesForTest(request, 100);
	}
	expect(request.listeners("error")).toEqual([providerError]);
	expect(request.listeners("close")).toEqual([providerClose]);
});

for (const event of ["error", "close"] as const) {
	test(`${event} settles every pending frame and late callbacks cannot replace the first failure`, async () => {
		const { request, callbacks } = writer();
		const first = new Error("first callback failure");
		request.on("error", () => {});
		for (let i = 0; i < 12; i++) writeCursorFrameForTest(request, Buffer.from("frame"));
		callbacks[0](first);
		request.emit(event, new Error("later event failure"));
		expect(request.listenerCount("error")).toBe(1);
		expect(request.listenerCount("close")).toBe(0);
		for (const callback of callbacks) {
			callback();
			callback(new Error("late"));
		}
		await expect(waitForCursorWritesForTest(request, 100)).rejects.toBe(first);
	});
}

for (const event of ["error", "close"] as const) {
	test(`${event} before any callback fans out and preserves the event failure`, async () => {
		const { request, callbacks } = writer();
		const providerError = () => {};
		const providerClose = () => {};
		request.on("error", providerError);
		request.on("close", providerClose);
		for (let i = 0; i < 12; i++) writeCursorFrameForTest(request, Buffer.from("frame"));
		const first = new Error("first transport failure");
		request.emit(event, first);
		expect(request.listeners("error")).toEqual([providerError]);
		expect(request.listeners("close")).toEqual([providerClose]);
		for (const callback of callbacks) {
			callback(new Error("late callback failure"));
			callback();
		}
		const waiting = waitForCursorWritesForTest(request, 100);
		if (event === "error") await expect(waiting).rejects.toBe(first);
		else await expect(waiting).rejects.toThrow("Cursor request closed before write completed");
	});
}

test("synchronous nested writes retain their own shared listener lifetime", async () => {
	const { request } = writer();
	let nested = false;
	let nestedCallback: (() => void) | undefined;
	request.write = ((_frame: Uint8Array, callback: () => void) => {
		if (nested) {
			nestedCallback = callback;
			return false;
		}
		nested = true;
		expect(writeCursorFrameForTest(request, Buffer.from("nested"))).toBe(false);
		callback();
		return true;
	}) as typeof request.write;
	expect(writeCursorFrameForTest(request, Buffer.from("outer"))).toBe(true);
	expect(request.listenerCount("error")).toBe(1);
	expect(request.listenerCount("close")).toBe(1);
	let drained = false;
	const waiting = waitForCursorWritesForTest(request, 200).then(() => {
		drained = true;
	});
	await Promise.resolve();
	expect(drained).toBe(false);
	expect(nestedCallback).toBeDefined();
	nestedCallback!();
	await waiting;
	expect(request.listenerCount("error")).toBe(0);
	expect(request.listenerCount("close")).toBe(0);
});

test("retains a callback failure at pending zero through a successful second burst", async () => {
	const { request, callbacks } = writer(false);
	const first = new Error("first");
	expect(writeCursorFrameForTest(request, Buffer.from("first"))).toBe(false);
	callbacks[0](first);
	expect(request.listenerCount("error")).toBe(0);
	expect(writeCursorFrameForTest(request, Buffer.from("second"))).toBe(false);
	expect(request.listenerCount("error")).toBe(1);
	callbacks[1]();
	await expect(waitForCursorWritesForTest(request, 100)).rejects.toBe(first);
});

test("individual callbacks do not complete another frame or lose writes added during final drain", async () => {
	const { request, callbacks } = writer();
	writeCursorFrameForTest(request, Buffer.from("first"));
	let drained = false;
	const waiting = waitForCursorWritesForTest(request, 200).then(() => {
		drained = true;
	});
	writeCursorFrameForTest(request, Buffer.from("second"));
	callbacks[0]();
	await Bun.sleep(5);
	expect(drained).toBe(false);
	expect(request.listenerCount("close")).toBe(1);
	callbacks[1]();
	await waiting;
	expect(request.listenerCount("close")).toBe(0);
});

test("final drain deadline wins over synchronous close and handles late callbacks", async () => {
	const { request, callbacks } = writer();
	const providerError = () => {};
	request.on("error", providerError);
	for (let i = 0; i < 12; i++) writeCursorFrameForTest(request, Buffer.from("frame"));
	await expect(waitForCursorWritesForTest(request, 10)).rejects.toThrow("write drain timed out after 10ms");
	expect(request.closed).toBe(true);
	expect(request.destroyed).toBe(true);
	expect(request.listeners("error")).toEqual([providerError]);
	expect(request.listenerCount("close")).toBe(0);
	for (const callback of callbacks) callback(new Error("late"));
	request.emit("error", new Error("late transport"));
});

test("synchronous callback and dropped write-after-end leave no shared listeners", async () => {
	const request = Object.assign(new events.EventEmitter(), {
		write(_frame: Uint8Array, callback: () => void) {
			callback();
			return false;
		},
	}) as unknown as http2.ClientHttp2Stream;
	expect(writeCursorFrameForTest(request, Buffer.from("sync"))).toBe(false);
	expect(request.listenerCount("error")).toBe(0);
	await waitForCursorWritesForTest(request, 100);
	request.write = () => {
		throw Object.assign(new Error("ended"), { code: "ERR_STREAM_WRITE_AFTER_END" });
	};
	expect(writeCursorFrameForTest(request, Buffer.from("dropped"))).toBe(false);
	expect(request.listenerCount("close")).toBe(0);
	await waitForCursorWritesForTest(request, 100);
});
