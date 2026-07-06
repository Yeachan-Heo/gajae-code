import { describe, expect, it } from "bun:test";
import { WorkerIntegrationRequestScheduler } from "../src/session/agent-session";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>(value => {
		resolve = value;
	});
	return { promise, resolve };
}

async function tick(): Promise<void> {
	await Promise.resolve();
}

describe("team worker integration scheduler", () => {
	it("does not block enqueue on the async request", async () => {
		const first = deferred();
		let calls = 0;
		const scheduler = new WorkerIntegrationRequestScheduler(async () => {
			calls += 1;
			await first.promise;
		});

		scheduler.enqueue();

		expect(calls).toBe(1);
		first.resolve();
		await scheduler.flush();
	});

	it("runs at most one request in flight", async () => {
		const requests = [deferred(), deferred()];
		let calls = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		const scheduler = new WorkerIntegrationRequestScheduler(async () => {
			const request = requests[calls++];
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await request.promise;
			inFlight -= 1;
		});

		scheduler.enqueue();
		scheduler.enqueue();
		scheduler.enqueue();
		await tick();

		expect(calls).toBe(1);
		expect(maxInFlight).toBe(1);
		requests[0].resolve();
		await tick();
		await tick();
		expect(calls).toBe(2);
		expect(maxInFlight).toBe(1);
		requests[1].resolve();
		await scheduler.flush();
		expect(maxInFlight).toBe(1);
	});

	it("coalesces many requests during one in-flight request into exactly one trailing run", async () => {
		const requests = [deferred(), deferred()];
		let calls = 0;
		const scheduler = new WorkerIntegrationRequestScheduler(async () => {
			const request = requests[calls++];
			await request.promise;
		});

		scheduler.enqueue();
		for (let index = 0; index < 10; index += 1) scheduler.enqueue();
		await tick();

		expect(calls).toBe(1);
		requests[0].resolve();
		await tick();
		await tick();
		expect(calls).toBe(2);
		requests[1].resolve();
		await scheduler.flush();
		expect(calls).toBe(2);
	});

	it("flush waits for the in-flight request and trailing pending request", async () => {
		const requests = [deferred(), deferred()];
		let calls = 0;
		let flushed = false;
		const scheduler = new WorkerIntegrationRequestScheduler(async () => {
			const request = requests[calls++];
			await request.promise;
		});

		scheduler.enqueue();
		scheduler.enqueue();
		const flushPromise = scheduler.flush().then(() => {
			flushed = true;
		});
		await tick();

		expect(flushed).toBe(false);
		requests[0].resolve();
		await tick();
		await tick();
		expect(calls).toBe(2);
		expect(flushed).toBe(false);
		requests[1].resolve();
		await flushPromise;
		expect(flushed).toBe(true);
		expect(calls).toBe(2);
	});

	it("terminates flush with a coalesced trailing run after enqueue during an in-flight request", async () => {
		const requests = [deferred(), deferred()];
		let calls = 0;
		let flushed = false;
		const scheduler = new WorkerIntegrationRequestScheduler(async () => {
			const request = requests[calls++];
			expect(request).toBeDefined();
			await request.promise;
		});

		scheduler.enqueue();
		await tick();
		expect(calls).toBe(1);

		const flushPromise = scheduler.flush().then(() => {
			flushed = true;
		});
		await tick();
		expect(flushed).toBe(false);

		for (let index = 0; index < 5; index += 1) scheduler.enqueue();
		requests[0].resolve();
		await tick();
		await tick();
		expect(calls).toBe(2);
		expect(flushed).toBe(false);

		requests[1].resolve();
		await flushPromise;
		expect(flushed).toBe(true);
		expect(calls).toBe(2);
	});
});
