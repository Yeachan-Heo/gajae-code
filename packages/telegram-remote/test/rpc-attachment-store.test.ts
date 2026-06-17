import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_ATTACHMENT_FILE_NAME, RpcAttachmentStore } from "../src/rpc-attachment-store";
import type { AttachmentRecord } from "../src/types";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "gtr-rpc-attachment-"));
}

function attachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
	return {
		chatId: "100",
		userId: "100",
		socketPath: "/tmp/gjc.sock",
		stale: false,
		controllerState: "attached_idle",
		pendingGateIds: ["gate-1"],
		deliveryIdentities: [{ role: "assistant", contentHash: "abc", messageIndex: 1 }],
		chunkProgress: { deliveryId: "abc", nextChunkIndex: 1, chunkCount: 3 },
		updatedAt: 1,
		...overrides,
	};
}

describe("RpcAttachmentStore", () => {
	test("persists and reloads the single attachment", async () => {
		const dir = await tempDir();
		const store = await RpcAttachmentStore.open({ stateDir: dir });
		await store.set(attachment());
		const reloaded = await RpcAttachmentStore.open({ stateDir: dir });
		expect(reloaded.get()).toEqual(attachment());
	});

	test("writes atomically with fixed filename", async () => {
		const dir = await tempDir();
		const store = await RpcAttachmentStore.open({ stateDir: dir });
		await store.set(attachment());
		const text = await readFile(join(dir, RPC_ATTACHMENT_FILE_NAME), "utf8");
		expect(JSON.parse(text).attachment.socketPath).toBe("/tmp/gjc.sock");
	});

	test("corrupt JSON fails closed to empty", async () => {
		const dir = await tempDir();
		await writeFile(join(dir, RPC_ATTACHMENT_FILE_NAME), "{bad", "utf8");
		const store = await RpcAttachmentStore.open({ stateDir: dir });
		expect(store.get()).toBeNull();
	});

	test("clear removes the attachment", async () => {
		const dir = await tempDir();
		const store = await RpcAttachmentStore.open({ stateDir: dir });
		await store.set(attachment());
		await store.clear();
		expect(store.get()).toBeNull();
	});

	test("marks attachment stale", async () => {
		const dir = await tempDir();
		const store = await RpcAttachmentStore.open({ stateDir: dir });
		await store.set(attachment());
		await store.markStale(5);
		expect(store.get()?.stale).toBe(true);
		expect(store.get()?.controllerState).toBe("stale");
		expect(store.get()?.updatedAt).toBe(5);
	});

	test("schema drops event-store keys", async () => {
		const dir = await tempDir();
		const store = await RpcAttachmentStore.open({ stateDir: dir });
		await store.set({ ...attachment(), events: [{ raw: true }], watchCursor: 99 } as AttachmentRecord);
		const saved = JSON.parse(await readFile(join(dir, RPC_ATTACHMENT_FILE_NAME), "utf8"));
		expect(saved.attachment.events).toBeUndefined();
		expect(saved.attachment.watchCursor).toBeUndefined();
		expect(Object.keys(saved.attachment).sort()).toEqual([
			"chatId",
			"chunkProgress",
			"controllerState",
			"deliveryIdentities",
			"pendingGateIds",
			"socketPath",
			"stale",
			"updatedAt",
			"userId",
		]);
	});
});
