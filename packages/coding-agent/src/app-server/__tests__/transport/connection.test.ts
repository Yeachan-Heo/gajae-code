import { expect, test } from "bun:test";
import { createAppServerRuntime } from "../../create-app-server";
import { BoundedOutboundQueue } from "../../transport/connection";

const enc = (value: string) => new TextEncoder().encode(value);

test("BoundedOutboundQueue: enqueues and flushes frames in order", async () => {
	const sent: number[] = [];
	const q = new BoundedOutboundQueue({
		capacity: 4,
		send: async frame => {
			sent.push(Number(new TextDecoder().decode(frame)));
		},
	});
	await q.enqueue(enc("1"));
	await q.enqueue(enc("2"));
	await q.enqueue(enc("3"));
	await Bun.sleep(0);
	expect(sent).toEqual([1, 2, 3]);
	expect(q.queued).toBe(0);
});

	test("BoundedOutboundQueue: flush finalization starts a pump for a newly accepted frame", async () => {
	const sent: string[] = [];
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const q = new BoundedOutboundQueue({
		capacity: 1,
		send: async frame => {
			if (sent.length === 0) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			sent.push(new TextDecoder().decode(frame));
		},
	});
	const first = q.enqueue(enc("first"));
	await firstStarted.promise;
	const second = q.enqueue(enc("second"));
	releaseFirst.resolve();
	await Promise.all([first, second]);
	await q.close();
	expect(sent).toEqual(["first", "second"]);
});

test("BoundedOutboundQueue: waits for capacity instead of dropping a slow client's frame", async () => {
	const sent: string[] = [];
	const sendStarted = Promise.withResolvers<void>();
	const unblockSend = Promise.withResolvers<void>();
	const q = new BoundedOutboundQueue({
		capacity: 2,
		send: async frame => {
			sendStarted.resolve();
			await unblockSend.promise;
			sent.push(new TextDecoder().decode(frame));
		},
	});

	const first = q.enqueue(enc("1"));
	await sendStarted.promise;
	const second = q.enqueue(enc("2"));
	let thirdSettled = false;
	const third = q.enqueue(enc("3")).finally(() => {
		thirdSettled = true;
	});
	await Bun.sleep(0);
	expect(thirdSettled).toBe(false);
	unblockSend.resolve();
	await Promise.all([first, second, third]);
	expect(sent).toEqual(["1", "2", "3"]);
});

test("BoundedOutboundQueue: close prevents further enqueues", async () => {
	const q = new BoundedOutboundQueue({ send: async () => {} });
	await q.close();
	expect(q.closed).toBe(true);
	expect(await q.enqueue(enc("x"))).toBe(false);
});

test("BoundedOutboundQueue: writer failure rejects the enqueue that accepted the frame", async () => {
	const q = new BoundedOutboundQueue({
		send: async () => {
			throw new Error("transport down");
		},
	});
	await expect(q.enqueue(enc("first"))).rejects.toThrow("transport down");
	await expect(q.close()).rejects.toThrow("transport down");
});

test("BoundedOutboundQueue: close waits until every accepted frame is sent", async () => {
	const sent: string[] = [];
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const q = new BoundedOutboundQueue({
		send: async frame => {
			if (sent.length === 0) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			sent.push(new TextDecoder().decode(frame));
		},
	});
	const first = q.enqueue(enc("first"));
	await firstStarted.promise;
	const second = q.enqueue(enc("second"));
	let closed = false;
	const closing = q.close().then(() => {
		closed = true;
	});
	await Bun.sleep(0);
	expect(closed).toBe(false);
	releaseFirst.resolve();
	await Promise.all([first, second, closing]);
	expect(sent).toEqual(["first", "second"]);
});

test("runtime connection: concurrent close callers wait for and share a writer failure", async () => {
	const writerStarted = Promise.withResolvers<void>();
	const releaseWriter = Promise.withResolvers<void>();
	let failWriter = false;
	const runtime = createAppServerRuntime();
	const connection = runtime.createConnection(async () => {
		if (!failWriter) return;
		writerStarted.resolve();
		await releaseWriter.promise;
		throw new Error("writer failed during close");
	});
	await connection.process(
		enc('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"1"}}}'),
	);
	await connection.process(enc('{"method":"initialized"}'));
	failWriter = true;
	const processing = connection.process(enc('{"id":2,"method":"fs/readFile","params":{"path":"/tmp/test"}}'));
	await writerStarted.promise;
	let firstSettled = false;
	let secondSettled = false;
	const firstClose = connection.close().finally(() => {
		firstSettled = true;
	});
	const secondClose = connection.close().finally(() => {
		secondSettled = true;
	});
	await Bun.sleep(0);
	expect(firstSettled).toBe(false);
	expect(secondSettled).toBe(false);
	const processingResult = processing.then(
		() => undefined,
		error => error,
	);
	const firstCloseResult = firstClose.then(
		() => undefined,
		error => error,
	);
	const secondCloseResult = secondClose.then(
		() => undefined,
		error => error,
	);
	releaseWriter.resolve();
	const [processingError, firstCloseError, secondCloseError] = await Promise.all([
		processingResult,
		firstCloseResult,
		secondCloseResult,
	]);
	expect(processingError).toMatchObject({ message: "writer failed during close" });
	expect(firstCloseError).toMatchObject({ message: "writer failed during close" });
	expect(secondCloseError).toMatchObject({ message: "writer failed during close" });
});
