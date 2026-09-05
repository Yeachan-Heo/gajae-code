import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { RevisionStore } from "../src/sdk/host/query/revision-store";
import { REVERSE_RECLAIM_GRACE_MS, ReverseLeaseRuntime } from "../src/sdk/host/reverse-leases";
import {
	REQUEST_FRAME_BYTES,
	type RelayWebSocket,
	type RelayWebSocketEvent,
	startRelayPair,
	type TransportError,
} from "../src/sdk/transport/relay";

class TestWebSocket implements RelayWebSocket {
	readyState = 0;
	readonly bufferedAmount = 0;
	readonly messages: string[] = [];
	readonly #events = new Map<string, Set<(event: RelayWebSocketEvent) => void>>();

	addEventListener(type: string, listener: (event: RelayWebSocketEvent) => void): void {
		let listeners = this.#events.get(type);
		if (!listeners) {
			listeners = new Set();
			this.#events.set(type, listeners);
		}
		listeners.add(listener);
	}
	removeEventListener(type: string, listener: (event: RelayWebSocketEvent) => void): void {
		this.#events.get(type)?.delete(listener);
	}
	emit(type: string, event: RelayWebSocketEvent = {}): void {
		for (const listener of this.#events.get(type) ?? []) listener(event);
	}
	send(data: string): void {
		this.messages.push(data);
	}
	close(): void {
		this.readyState = 3;
		this.emit("close");
	}
}

async function relay(sink: Writable = new PassThrough()) {
	const ws = new TestWebSocket();
	const input = new PassThrough();
	const errors: TransportError[] = [];
	const started = startRelayPair({
		url: "ws://test",
		token: "token",
		pendingCeilingBytes: REQUEST_FRAME_BYTES,
		downstream: input,
		downstreamSink: sink,
		onTransportError: error => errors.push(error),
		webSocketFactory: () => ws,
	});
	ws.readyState = 1;
	ws.emit("open");
	return { pair: await started, ws, input, sink, errors };
}

describe("SDK transport/store bounded hot paths", () => {
	test("reads a spilled multi-row page once and rechecks chunk integrity on every page", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-page-perf-"));
		const ranges: Array<[number, number]> = [];
		const store = new RevisionStore("test", Date.now, {
			storageDir: directory,
			onReadRange: (start, end) => ranges.push([start, end]),
		});
		try {
			const rows = [{ text: "漢🙂" }, null, [1, "escaped\n"]];
			const revision = await store.createRevision("rows", "id", [...rows, "x".repeat(17 * 1024 * 1024)]);
			const read = spyOn(fs, "readFile");
			let chunkPath = "";
			try {
				expect(await store.readPage("rows", "id", revision, 0, 1024)).toEqual({ items: rows, complete: false });
				expect(read).toHaveBeenCalledTimes(1);
				expect(ranges).toEqual([[1, Buffer.byteLength(JSON.stringify(rows)) - 1]]);
				chunkPath = String(read.mock.calls[0]![0]);
			} finally {
				read.mockRestore();
			}
			const bytes = await Bun.file(chunkPath).bytes();
			bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
			await Bun.write(chunkPath, bytes);
			await expect(store.readPage("rows", "id", revision, 0, 1024)).rejects.toThrow(
				"snapshot chunk does not match manifest",
			);
		} finally {
			await store.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("keeps canonical page boundaries, empty pages, and first-item allowance", async () => {
		const store = new RevisionStore("boundaries");
		try {
			const rows = [null, "漢", { line: "\n" }];
			const revision = await store.createRevision("rows", "id", rows);
			expect(await store.readPage("rows", "id", revision, 0, 4)).toEqual({ items: [null], complete: false });
			expect(await store.readPage("rows", "id", revision, 0, 3)).toEqual({ items: [], complete: false });
			expect(await store.readPage("rows", "id", revision, 1, 1024)).toEqual({
				items: rows.slice(1),
				complete: true,
			});
			expect(await store.readPage("rows", "id", revision, 3, 1024)).toEqual({ items: [], complete: true });
		} finally {
			await store.close();
		}
	});

	test("disconnect preserves receipts for connection IDs containing the disconnected ID and NUL", () => {
		const runtime = new ReverseLeaseRuntime({ sendFrame: () => {} });
		try {
			runtime.registerProvider("a", "filesystem", { old: true }, undefined, "receipt");
			runtime.registerProvider("a\u0000x", "network", { old: true }, undefined, "receipt");
			runtime.disconnect("a");
			expect(() => runtime.registerProvider("a\u0000x", "network", { changed: true }, undefined, "receipt")).toThrow(
				"idempotency_conflict",
			);
			const registered = runtime.registerProvider("a", "filesystem", { changed: true }, undefined, "receipt");
			expect(registered.definitions).toEqual({ changed: true });
			expect(runtime.getInstalledDefinitions("network")).toEqual({ old: true });
		} finally {
			runtime.dispose();
		}
	});

	test("disconnect clears only matching connection receipts and preserves lease reclaim grace", () => {
		let now = 100;
		const removed: string[] = [];
		const runtime = new ReverseLeaseRuntime({
			now: () => now,
			sendFrame: () => {},
			onDefinitionsRemoved: capability => removed.push(capability),
		});
		try {
			const lease = runtime.registerProvider("one", "filesystem", { old: true }, undefined, "receipt");
			const other = runtime.registerProvider("one-extra", "network", {}, undefined, "receipt");
			runtime.disconnect("one");
			expect(removed).toEqual(["filesystem"]);
			expect(runtime.heartbeat("one-extra", other.leaseId).leaseId).toBe(other.leaseId);
			expect(() =>
				runtime.registerProvider("one-extra", "network", { changed: true }, undefined, "receipt"),
			).toThrow("idempotency_conflict");
			now += REVERSE_RECLAIM_GRACE_MS;
			const reclaimed = runtime.registerProvider("one", "filesystem", { changed: true }, lease.leaseId, "receipt");
			expect(reclaimed.leaseId).toBe(lease.leaseId);
			expect(reclaimed.graceUntil).toBeUndefined();
			expect(reclaimed.expiresAt).toBeGreaterThan(now);
		} finally {
			runtime.dispose();
		}
	});

	for (const termination of ["relay", "sink", "error", "drain"] as const) {
		test(`${termination} releases every downstream backpressure listener`, async () => {
			const sink = new Writable({ highWaterMark: 1, write() {} });
			const fixture = await relay(sink);
			try {
				fixture.ws.emit("message", { data: "response" });
				for (const event of ["drain", "error", "close"]) expect(sink.listenerCount(event)).toBe(1);
				if (termination === "relay") await fixture.pair.close();
				else if (termination === "sink") sink.emit("close");
				else if (termination === "error") sink.emit("error", new Error("sink failed"));
				else sink.emit("drain");
				if (termination === "sink") await expect(fixture.pair.done).rejects.toThrow("downstream_closed");
				else if (termination === "error") await expect(fixture.pair.done).rejects.toThrow("sink failed");
				else {
					await fixture.pair.close();
					await fixture.pair.done;
				}
				for (const event of ["drain", "error", "close"]) expect(sink.listenerCount(event)).toBe(0);
				expect(sink.destroyed).toBe(false);
			} finally {
				await fixture.pair.close();
				sink.destroy();
			}
		});
	}

	test("forwards 256 one-KiB fragments byte-identically with one frame concatenation", async () => {
		const fixture = await relay();
		try {
			const frame = Buffer.from(`"${"漢🙂x".repeat(32767)}${" ".repeat(6)}"`);
			expect(frame.length).toBe(REQUEST_FRAME_BYTES);
			const concat = spyOn(Buffer, "concat");
			try {
				for (let offset = 0; offset < frame.length; offset += 1024)
					fixture.input.emit("data", frame.subarray(offset, offset + 1024));
				expect(fixture.ws.messages).toEqual([]);
				fixture.input.emit("data", Buffer.from("\n"));
				expect(fixture.ws.messages).toEqual([frame.toString("utf8")]);
				expect(concat).toHaveBeenCalledTimes(1);
			} finally {
				concat.mockRestore();
			}
		} finally {
			await fixture.pair.close();
		}
	});

	for (const withNewline of [false, true]) {
		test(`rejects fragmented oversize frames ${withNewline ? "with" : "without"} newline`, async () => {
			const fixture = await relay();
			try {
				for (let index = 0; index < 256; index++) fixture.input.emit("data", Buffer.alloc(1024, 120));
				fixture.input.emit("data", Buffer.from(withNewline ? "x\n" : "x"));
				await expect(fixture.pair.done).rejects.toThrow("frame_oversize");
				expect(fixture.errors).toEqual([
					{ type: "transport_error", code: "frame_oversize", direction: "downstream->ws" },
				]);
				expect(fixture.ws.messages).toEqual([]);
			} finally {
				await fixture.pair.close();
			}
		});
	}

	test("rejects an empty frame after a complete frame in the same chunk", async () => {
		const fixture = await relay();
		try {
			fixture.input.emit("data", Buffer.from("{}\n\n"));
			await expect(fixture.pair.done).rejects.toThrow("protocol_error");
			expect(fixture.ws.messages).toEqual(["{}"]);
			expect(fixture.errors).toEqual([
				{ type: "transport_error", code: "protocol_error", direction: "downstream->ws" },
			]);
		} finally {
			await fixture.pair.close();
		}
	});
});
