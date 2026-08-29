import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { type CursorHttp2WriteStream, writeCursorHttp2Frame } from "../src/providers/cursor";

function endedStream(
	overrides?: Partial<CursorHttp2WriteStream> & { write?: CursorHttp2WriteStream["write"] },
): CursorHttp2WriteStream {
	return {
		closed: false,
		destroyed: false,
		writableEnded: true,
		writable: false,
		write: () => {
			throw new Error("write should not be called");
		},
		...overrides,
	};
}

describe("writeCursorHttp2Frame", () => {
	it("skips write when the HTTP/2 stream has already ended", () => {
		let wrote = 0;
		const stream = endedStream({
			write: () => {
				wrote += 1;
				return true;
			},
		});
		expect(writeCursorHttp2Frame(stream, new Uint8Array([1]))).toBe(false);
		expect(wrote).toBe(0);
	});

	it("swallows a synchronous write-after-end error", () => {
		const stream: CursorHttp2WriteStream = {
			closed: false,
			destroyed: false,
			writableEnded: false,
			write: () => {
				throw new Error("write after end");
			},
		};
		expect(writeCursorHttp2Frame(stream, new Uint8Array([1]))).toBe(false);
	});

	it("does not leak an unhandled rejection when write() returns a rejected promise", async () => {
		const rejections: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const stream: CursorHttp2WriteStream = {
				closed: false,
				destroyed: false,
				writableEnded: false,
				write: () => Promise.reject(new Error("write after end")),
			};
			expect(writeCursorHttp2Frame(stream, new Uint8Array([1]))).toBe(true);
			await Bun.sleep(0);
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("waits for drain when the write callback fires first under backpressure", () => {
		const stream = new EventEmitter() as EventEmitter & CursorHttp2WriteStream;
		Object.assign(stream, {
			closed: false,
			destroyed: false,
			writableEnded: false,
			writable: true,
		});
		let firstCallback: ((error?: Error | null) => void) | undefined;
		let secondCallback: ((error?: Error | null) => void) | undefined;
		let writes = 0;
		stream.write = (_chunk, cb) => {
			writes += 1;
			if (writes === 1) {
				firstCallback = cb;
				return false;
			}
			secondCallback = cb;
			return true;
		};
		let completions = 0;
		let completionError: Error | null = null;

		expect(
			writeCursorHttp2Frame(stream, new Uint8Array([2]), error => {
				completions += 1;
				completionError = error;
				writeCursorHttp2Frame(stream, new Uint8Array([4]), nextError => {
					expect(nextError).toBeNull();
					completions += 1;
				});
			}),
		).toBe(true);
		firstCallback?.(null);
		expect(completions).toBe(0);
		expect(writes).toBe(1);
		expect(stream.listenerCount("drain")).toBe(1);

		stream.emit("drain");
		expect(completions).toBe(1);
		expect(writes).toBe(2);
		secondCallback?.(null);
		expect(completions).toBe(2);
		expect(completionError).toBeNull();
		expect(stream.listenerCount("drain")).toBe(0);
		expect(stream.listenerCount("error")).toBe(0);
		expect(stream.listenerCount("close")).toBe(0);
	});

	it.each(["close", "error"] as const)("cleans up listeners when the stream emits %s", event => {
		const stream = new EventEmitter() as EventEmitter & CursorHttp2WriteStream;
		Object.assign(stream, {
			closed: false,
			destroyed: false,
			writableEnded: false,
			writable: true,
		});
		stream.write = () => false;
		let completions = 0;
		let completionError: Error | null = null;

		expect(
			writeCursorHttp2Frame(stream, new Uint8Array([3]), error => {
				completions += 1;
				completionError = error;
			}),
		).toBe(true);
		if (event === "error") stream.emit(event, new Error("write failed"));
		else stream.emit(event);

		expect(completions).toBe(1);
		expect(completionError).toBeInstanceOf(Error);
		expect(stream.listenerCount("drain")).toBe(0);
		expect(stream.listenerCount("error")).toBe(0);
		expect(stream.listenerCount("close")).toBe(0);
	});

	it("cleans up listeners when write throws an unexpected synchronous error", () => {
		const stream = new EventEmitter() as EventEmitter & CursorHttp2WriteStream;
		Object.assign(stream, {
			closed: false,
			destroyed: false,
			writableEnded: false,
			writable: true,
		});
		stream.write = () => {
			throw new Error("unexpected write failure");
		};

		expect(() => writeCursorHttp2Frame(stream, new Uint8Array([5]))).toThrow("unexpected write failure");
		expect(stream.listenerCount("drain")).toBe(0);
		expect(stream.listenerCount("error")).toBe(0);
		expect(stream.listenerCount("close")).toBe(0);
	});
});
