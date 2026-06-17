import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkForDelivery, formatExitAlert, formatLivenessAlert } from "../src/projection";
import { RpcAttachmentStore } from "../src/rpc-attachment-store";
import { FakeRpcBackend } from "../src/rpc-backend";
import { RpcEventBridge } from "../src/rpc-event-bridge";
import type { AttachmentRecord, ChatReply } from "../src/types";

const binding = { chatId: "900", userId: "100" };

async function storeWith(attachment: Partial<AttachmentRecord> = {}) {
	const dir = await mkdtemp(join(tmpdir(), "gtr-rpc-events-"));
	const store = await RpcAttachmentStore.open({ stateDir: dir });
	await store.set({
		chatId: binding.chatId,
		userId: binding.userId,
		socketPath: "/tmp/gjc.sock",
		stale: false,
		pendingGateIds: [],
		deliveryIdentities: [],
		updatedAt: 0,
		...attachment,
	});
	return store;
}

function outbound(failAt: number[] = []) {
	const sent: Array<{ chatId: string; reply: ChatReply }> = [];
	let calls = 0;
	return {
		sent,
		port: {
			send: async (message: { chatId: string; reply: ChatReply }) => {
				const callIndex = calls;
				calls += 1;
				if (failAt.includes(callIndex)) return { ok: false, retryAfterMs: 2000 };
				sent.push(message);
				return { ok: true };
			},
		},
	};
}

function manualClock() {
	const callbacks: Array<() => void> = [];
	return {
		clock: {
			setInterval: (callback: () => void) => {
				callbacks.push(callback);
				return 1 as never;
			},
			clearInterval: () => undefined,
		},
		tick: async () => {
			for (const callback of callbacks) callback();
			await flush();
		},
	};
}

async function flush() {
	for (let index = 0; index < 5; index += 1) {
		await Promise.resolve();
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

async function waitForSent(out: ReturnType<typeof outbound>, count: number) {
	for (let index = 0; index < 25; index += 1) {
		if (out.sent.length >= count) return;
		await Promise.resolve();
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}

describe("RpcEventBridge", () => {
	test("turn_end delivers the last assistant message escaped in ordered <=4096 chunks", async () => {
		const store = await storeWith();
		const backend = new FakeRpcBackend();
		const raw = `${"<&".repeat(820)} done`;
		backend.messages = [
			{ role: "user", content: "ignore" } as never,
			{ role: "assistant", content: "old", index: 1, timestamp: "t1" } as never,
			{ role: "assistant", content: raw, index: 2, timestamp: "t2" } as never,
		];
		const out = outbound();
		const bridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: out.port, livenessMs: 1000 });
		bridge.start();
		backend.emitEvent({ type: "turn_end" });
		await flush();

		const expected = chunkForDelivery(raw);
		await waitForSent(out, expected.length);
		expect(out.sent.map(item => item.reply.text)).toEqual(expected);
		expect(out.sent.every(item => item.reply.text.length <= 4096)).toBe(true);
		expect(out.sent.join(" ")).not.toContain("<");
		expect(store.get()?.deliveryIdentities).toHaveLength(1);
	});

	test("durable identity dedupe skips same identity", async () => {
		const store = await storeWith();
		const backend = new FakeRpcBackend();
		backend.messages = [{ role: "assistant", content: "same", index: 7, timestamp: "t" } as never];
		const out = outbound();
		const bridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: out.port });
		await bridge.deliverFinalAnswer();
		await bridge.deliverFinalAnswer();
		expect(out.sent.map(item => item.reply.text)).toEqual(["same"]);
		expect(store.get()?.deliveryIdentities).toHaveLength(1);
	});

	test("identity suppresses index drift when turnId is stable", async () => {
		const store = await storeWith();
		const backend = new FakeRpcBackend();
		const out = outbound();
		const bridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: out.port });
		backend.messages = [{ role: "assistant", content: "repeat", index: 1, metadata: { turnId: "t1" } } as never];
		await bridge.deliverFinalAnswer();
		backend.messages = [{ role: "assistant", content: "repeat", index: 3, metadata: { turnId: "t1" } } as never];
		await bridge.deliverFinalAnswer();
		expect(out.sent.map(item => item.reply.text)).toEqual(["repeat"]);
		expect(store.get()?.deliveryIdentities).toHaveLength(1);
	});

	test("identity delivers index reuse when turnId changes", async () => {
		const store = await storeWith();
		const backend = new FakeRpcBackend();
		const out = outbound();
		const bridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: out.port });
		backend.messages = [{ role: "assistant", content: "repeat", index: 1, metadata: { turnId: "t1" } } as never];
		await bridge.deliverFinalAnswer();
		backend.messages = [{ role: "assistant", content: "repeat", index: 1, metadata: { turnId: "t2" } } as never];
		await bridge.deliverFinalAnswer();
		expect(out.sent.map(item => item.reply.text)).toEqual(["repeat", "repeat"]);
		expect(store.get()?.deliveryIdentities).toHaveLength(2);
	});

	test("fallback path uses getLastAssistantText with fallback identity", async () => {
		const store = await storeWith();
		const backend = new FakeRpcBackend();
		backend.messages = [];
		backend.lastAssistantText = "fallback <answer>";
		const out = outbound();
		const bridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: out.port });
		await bridge.deliverFinalAnswer();
		expect(out.sent.map(item => item.reply.text)).toEqual(["fallback &lt;answer&gt;"]);
		expect(store.get()?.deliveryIdentities[0].fallback).toBe(true);
	});

	test("partial chunk failure persists progress and a new bridge resync resumes remaining chunks", async () => {
		const raw = `${"x".repeat(4096)}${"y".repeat(10)}`;
		const store = await storeWith();
		const backend = new FakeRpcBackend();
		backend.messages = [{ role: "assistant", content: raw, index: 3, timestamp: "t3" } as never];
		const first = outbound([1]);
		const bridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: first.port, now: () => 10 });
		await bridge.deliverFinalAnswer();
		expect(first.sent.map(item => item.reply.text)).toEqual([
			"x".repeat(4096),
			"Final answer delivery paused; retry after 2s.",
		]);
		expect(store.get()?.chunkProgress?.nextChunkIndex).toBe(1);
		expect(store.get()?.chunkProgress?.failedAt).toBe(10);
		expect(store.get()?.deliveryIdentities).toHaveLength(0);

		const second = outbound();
		const bridge2 = new RpcEventBridge({
			backend,
			attachments: store,
			binding,
			outbound: second.port,
			now: () => 20,
		});
		await bridge2.resync();
		expect(second.sent.map(item => item.reply.text)).toEqual(["y".repeat(10)]);
		expect(store.get()?.chunkProgress).toBeUndefined();
		expect(store.get()?.deliveryIdentities).toHaveLength(1);
	});

	test("resync with repeated chunk failure sends one failure notice", async () => {
		const raw = `${"x".repeat(4096)}${"y".repeat(10)}`;
		const store = await storeWith({
			chunkProgress: {
				deliveryId: "message:3::t3:113157765c207a719c99a4ba1654a1e5",
				nextChunkIndex: 1,
				chunkCount: 2,
				failedAt: 10,
			},
		});
		const backend = new FakeRpcBackend();
		backend.messages = [{ role: "assistant", content: raw, index: 3, timestamp: "t3" } as never];
		const out = outbound([0]);
		const bridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: out.port, now: () => 20 });
		await bridge.resync();
		expect(out.sent.map(item => item.reply.text)).toEqual(["Final answer delivery paused; retry after 2s."]);
		expect(store.get()?.chunkProgress?.nextChunkIndex).toBe(1);
		expect(store.get()?.deliveryIdentities).toHaveLength(0);
	});

	test("liveness timeout fires exactly one alert and marks stale", async () => {
		const nowRef = { value: 0 };
		const { clock, tick } = manualClock();
		const store = await storeWith({ liveness: { lastSeenAt: 0, timeoutMs: 100 } });
		const backend = new FakeRpcBackend();
		const out = outbound();
		const bridge = new RpcEventBridge({
			backend,
			attachments: store,
			binding,
			outbound: out.port,
			now: () => nowRef.value,
			livenessMs: 100,
			clock,
		});
		bridge.start();
		nowRef.value = 101;
		await tick();
		await tick();
		expect(out.sent.map(item => item.reply.text)).toEqual([formatLivenessAlert()]);
		expect(store.get()?.stale).toBe(true);
	});

	test("session-exit event fires one alert and no alert when stale", async () => {
		const store = await storeWith();
		const backend = new FakeRpcBackend();
		const out = outbound();
		const bridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: out.port });
		bridge.start();
		backend.emitEvent({ type: "session_exit" });
		backend.emitEvent({ type: "agent_dead" });
		await flush();
		expect(out.sent.map(item => item.reply.text)).toEqual([formatExitAlert()]);
		expect(store.get()?.stale).toBe(true);

		const staleOut = outbound();
		const staleBridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: staleOut.port });
		await staleBridge.alertExitOnce("exit");
		expect(staleOut.sent).toHaveLength(0);
	});

	test("delivery identities are capped to the most recent 100 entries", async () => {
		const oldIdentities = Array.from({ length: 100 }, (_, index) => ({
			role: "assistant" as const,
			contentHash: `old-${index}`,
			messageIndex: index,
		}));
		const store = await storeWith({ deliveryIdentities: oldIdentities });
		const backend = new FakeRpcBackend();
		backend.messages = [{ role: "assistant", content: "new", index: 101, timestamp: 123 } as never];
		const out = outbound();
		const bridge = new RpcEventBridge({ backend, attachments: store, binding, outbound: out.port });
		await bridge.deliverFinalAnswer();
		const identities = store.get()?.deliveryIdentities ?? [];
		expect(identities).toHaveLength(100);
		expect(identities[0]?.contentHash).toBe("old-1");
		expect(identities.at(-1)?.timestamp).toBe("123");
	});
});
