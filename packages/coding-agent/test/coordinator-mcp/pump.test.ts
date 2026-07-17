import { describe, expect, it } from "bun:test";
import { pumpCoordinatorMcpStream } from "../../src/coordinator-mcp/server";

type Rpc = {
	jsonrpc: "2.0";
	id?: number | string | null;
	method?: string;
	result?: unknown;
	error?: { code: number; message: string };
};

const tick = () => new Promise(r => setTimeout(r, 5));
const line = (id: number, method = "data") => `${JSON.stringify({ jsonrpc: "2.0", id, method })}\n`;

function deferred<T = void>() {
	let resolve!: (v: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

/** Controllable async-iterable stdin: push frames, then close() to signal EOF. */
function channel() {
	const queue: string[] = [];
	const waiters: Array<(r: IteratorResult<string>) => void> = [];
	let closed = false;
	return {
		push(v: string) {
			const w = waiters.shift();
			if (w) w({ value: v, done: false });
			else queue.push(v);
		},
		close() {
			closed = true;
			let w = waiters.shift();
			while (w) {
				w({ value: undefined as unknown as string, done: true });
				w = waiters.shift();
			}
		},
		[Symbol.asyncIterator]() {
			return {
				next(): Promise<IteratorResult<string>> {
					if (queue.length) return Promise.resolve({ value: queue.shift() as string, done: false });
					if (closed) return Promise.resolve({ value: undefined as unknown as string, done: true });
					return new Promise(res => waiters.push(res));
				},
			};
		},
	};
}

describe("pumpCoordinatorMcpStream — keepalive under a gated slow call", () => {
	it("answers ping while a data handler is still gated (no head-of-line blocking)", async () => {
		const gate = deferred();
		const handler = async (req: Rpc): Promise<Rpc> => {
			if (req.method === "slow") await gate.promise;
			return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
		};
		const writes: Rpc[] = [];
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(handler as never, ch, l => {
			writes.push(JSON.parse(l));
		});
		ch.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slow" })}\n`);
		ch.push(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
		await tick();
		expect(writes.map(w => w.id)).toEqual([2]); // ping answered while slow still gated
		gate.resolve();
		await tick();
		expect(writes.map(w => w.id)).toEqual([2, 1]);
		ch.close();
		await pump;
	});
});

describe("pumpCoordinatorMcpStream — bounded fanout", () => {
	it("caps concurrent data handlers and queues the rest", async () => {
		const gate = deferred();
		let active = 0;
		let maxActive = 0;
		const handler = async (req: Rpc): Promise<Rpc> => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await gate.promise;
			active -= 1;
			return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
		};
		const writes: Rpc[] = [];
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(handler as never, ch, l => void writes.push(JSON.parse(l)), {
			maxDataConcurrency: 2,
			maxQueueDepth: 10,
		});
		for (let i = 1; i <= 4; i += 1) ch.push(line(i));
		await tick();
		expect(maxActive).toBe(2); // only 2 ran concurrently; 2 were queued
		gate.resolve();
		await tick();
		ch.close();
		await pump;
		expect(writes.length).toBe(4); // all eventually processed
	});

	it("answers ping even when the data-concurrency cap is fully saturated", async () => {
		const gate = deferred();
		const handler = async (req: Rpc): Promise<Rpc> => {
			if (req.method === "ping") return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
			await gate.promise; // data handlers stay gated → cap saturated
			return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
		};
		const writes: Rpc[] = [];
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(handler as never, ch, l => void writes.push(JSON.parse(l)), {
			maxDataConcurrency: 2,
			maxQueueDepth: 10,
		});
		for (let i = 1; i <= 4; i += 1) ch.push(line(i)); // 2 running + 2 queued
		ch.push(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })}\n`); // ping while saturated
		await tick();
		expect(writes.map(w => w.id)).toEqual([99]); // ping bypassed the saturated data cap
		gate.resolve();
		await tick();
		ch.close();
		await pump;
	});

	it("rejects overflow past the queue depth as server_busy instead of growing unboundedly", async () => {
		const gate = deferred();
		const handler = async (req: Rpc): Promise<Rpc> => {
			await gate.promise;
			return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
		};
		const writes: Rpc[] = [];
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(handler as never, ch, l => void writes.push(JSON.parse(l)), {
			maxDataConcurrency: 1,
			maxQueueDepth: 1,
		});
		ch.push(line(1)); // runs
		ch.push(line(2)); // queued
		ch.push(line(3)); // overflow → server_busy
		await tick();
		const busy = writes.find(w => w.error);
		expect(busy?.id).toBe(3);
		expect(busy?.error?.message).toContain("server_busy");
		gate.resolve();
		ch.close();
		await pump;
	});
});

describe("pumpCoordinatorMcpStream — EOF drain", () => {
	it("does not resolve until in-flight handlers settle, and flushes their responses", async () => {
		const gate = deferred();
		const handler = async (req: Rpc): Promise<Rpc> => {
			await gate.promise;
			return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
		};
		const writes: Rpc[] = [];
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(handler as never, ch, l => void writes.push(JSON.parse(l)));
		ch.push(line(1));
		await tick();
		ch.close(); // EOF while handler still gated
		let resolved = false;
		void pump.then(() => {
			resolved = true;
		});
		await tick();
		expect(resolved).toBe(false); // pump waits for the in-flight handler
		expect(writes.length).toBe(0);
		gate.resolve();
		await pump;
		expect(writes.map(w => w.id)).toEqual([1]); // response flushed before return
	});
});

describe("pumpCoordinatorMcpStream — writer robustness", () => {
	it("quietly terminalizes on a coded structural EPIPE without waiting for input EOF", async () => {
		let writeCalls = 0;
		const epipe = Object.assign(new Error("peer closed"), { code: "EPIPE" });
		const writeLine = () => {
			writeCalls += 1;
			throw epipe;
		};
		const handler = async (req: Rpc): Promise<Rpc> => ({ jsonrpc: "2.0", id: req.id ?? null, result: {} });
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(handler as never, ch, writeLine);
		ch.push(line(1));
		await expect(
			Promise.race([pump, Bun.sleep(100).then(() => Promise.reject(new Error("pump waited for EOF")))]),
		).resolves.toBeUndefined();
		expect(writeCalls).toBe(1); // terminalized after the first failed owned-sink write
	});

	it("does not promote queued side-effecting work after the peer closes", async () => {
		const gate = deferred();
		const dispatched: Array<string | number | null | undefined> = [];
		const epipe = Object.assign(new Error("peer closed"), { code: "EPIPE" });
		const handler = async (req: Rpc): Promise<Rpc> => {
			dispatched.push(req.id);
			if (req.id === 1) await gate.promise;
			return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
		};
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(
			handler as never,
			ch,
			() => {
				throw epipe;
			},
			{ maxDataConcurrency: 1 },
		);
		ch.push(line(1));
		ch.push(line(2));
		await tick();
		expect(dispatched).toEqual([1]);
		gate.resolve();
		await pump;
		expect(dispatched).toEqual([1]);
	});

	it("suppresses writes from already-running work after a coded peer closure", async () => {
		const first = deferred();
		const second = deferred();
		let writeCalls = 0;
		const epipe = Object.assign(new Error("peer closed"), { code: "EPIPE" });
		const handler = async (req: Rpc): Promise<Rpc> => {
			if (req.id === 1) await first.promise;
			else await second.promise;
			return { jsonrpc: "2.0", id: req.id ?? null, result: {} };
		};
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(
			handler as never,
			ch,
			() => {
				writeCalls += 1;
				throw epipe;
			},
			{ maxDataConcurrency: 2 },
		);
		ch.push(line(1));
		ch.push(line(2));
		await tick();
		first.resolve();
		await tick();
		second.resolve();
		await pump;
		expect(writeCalls).toBe(1);
	});

	it("propagates non-pipe writer faults", async () => {
		const failure = Object.assign(new Error("write failed"), { code: "EIO" });
		const handler = async (req: Rpc): Promise<Rpc> => ({ jsonrpc: "2.0", id: req.id ?? null, result: {} });
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(handler as never, ch, () => {
			throw failure;
		});
		ch.push(line(1));
		await expect(pump).rejects.toBe(failure);
	});

	it("propagates a deferred asynchronous writer failure", async () => {
		const failure = Object.assign(new Error("write failed"), { code: "EIO" });
		const completion = deferred<void>();
		const handler = async (req: Rpc): Promise<Rpc> => ({ jsonrpc: "2.0", id: req.id ?? null, result: {} });
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(handler as never, ch, () => completion.promise);
		ch.push(line(1));
		await tick();
		completion.reject(failure);
		await expect(pump).rejects.toBe(failure);
	});

	it("bounds a never-settling writer and suppresses queued late emissions", async () => {
		const firstWrite = deferred<void>();
		let writeCalls = 0;
		const handler = async (req: Rpc): Promise<Rpc> => ({ jsonrpc: "2.0", id: req.id ?? null, result: {} });
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(
			handler as never,
			ch,
			() => {
				writeCalls += 1;
				return firstWrite.promise;
			},
			{ maxDataConcurrency: 2, drainTimeoutMs: 20 },
		);
		ch.push(line(1));
		ch.push(line(2));
		ch.close();
		await expect(
			Promise.race([
				pump,
				Bun.sleep(250).then(() => Promise.reject(new Error("pump waited for a never-settling write"))),
			]),
		).resolves.toBeUndefined();
		expect(writeCalls).toBe(1);
		firstWrite.resolve();
		await tick();
		expect(writeCalls).toBe(1);
	});

	it("does not treat ERR_STREAM_DESTROYED as a peer closure before terminality is proven", async () => {
		const failure = Object.assign(new Error("destroyed"), { code: "ERR_STREAM_DESTROYED" });
		const handler = async (req: Rpc): Promise<Rpc> => ({ jsonrpc: "2.0", id: req.id ?? null, result: {} });
		const ch = channel();
		const pump = pumpCoordinatorMcpStream(handler as never, ch, () => {
			throw failure;
		});
		ch.push(line(1));
		await expect(pump).rejects.toBe(failure);
	});
});

describe("pumpCoordinatorMcpStream — public error boundary", () => {
	it("redacts handler exception text before writing JSON-RPC errors", async () => {
		const privateSentinel = "must-not-reach-public-json-rpc";
		const handler = async (): Promise<Rpc> => {
			throw new Error(`private path /tmp/${privateSentinel}`);
		};
		const writes: Rpc[] = [];
		const ch = channel();
		ch.push(line(1));
		ch.close();
		await pumpCoordinatorMcpStream(handler as never, ch, value => void writes.push(JSON.parse(value)));
		expect(writes).toEqual([
			{
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32603, message: "coordinator_request_failed" },
			},
		]);
		expect(JSON.stringify(writes)).not.toContain(privateSentinel);
	});
});

describe("pumpCoordinatorMcpStream — frame handling", () => {
	it("ignores notifications (no id) and malformed frames without crashing", async () => {
		const handler = async (req: Rpc): Promise<Rpc> => ({ jsonrpc: "2.0", id: req.id ?? null, result: { ok: true } });
		const writes: Rpc[] = [];
		const ch = channel();
		ch.push(`${JSON.stringify({ jsonrpc: "2.0", method: "notify" })}\n`); // no id → no response
		ch.push("{ this is not json }\n"); // malformed → ignored
		ch.push(line(7)); // real request → answered
		ch.close();
		await pumpCoordinatorMcpStream(handler as never, ch, l => void writes.push(JSON.parse(l)));
		expect(writes.map(w => w.id)).toEqual([7]);
	});
});
