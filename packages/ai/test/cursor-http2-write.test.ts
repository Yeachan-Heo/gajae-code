import { describe, expect, it } from "bun:test";
import { writeCursorHttp2Frame, type CursorHttp2WriteStream } from "../src/providers/cursor";

function endedStream(overrides?: Partial<CursorHttp2WriteStream> & { write?: CursorHttp2WriteStream["write"] }): CursorHttp2WriteStream {
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
});
