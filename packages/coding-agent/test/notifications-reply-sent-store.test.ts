import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonPaths } from "../src/sdk/bus/daemon-paths";
import { ReplySentStore, type ReplySentStoreFs } from "../src/sdk/bus/reply-sent-store";

const INDEX_FILENAME = "telegram-rich-sent-index.json";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-reply-store-test-"));
}

/**
 * In-memory filesystem modeling the store's atomic tmp-write + rename, with a
 * toggle to make writes fail on demand (for the no-op-on-failure contract).
 */
class FakeFs implements ReplySentStoreFs {
	readonly files = new Map<string, string>();
	failWrites = false;
	async mkdir(): Promise<unknown> {
		return undefined;
	}
	async readFile(p: string): Promise<string> {
		const value = this.files.get(p);
		if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return value;
	}
	async writeFile(p: string, data: string): Promise<void> {
		if (this.failWrites) throw new Error("simulated disk failure");
		this.files.set(p, data);
	}
	async rename(from: string, to: string): Promise<void> {
		const value = this.files.get(from);
		if (value === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		this.files.delete(from);
		this.files.set(to, value);
	}
	async chmod(): Promise<void> {}
}

const AGENT = "/virtual/agent";
const indexPathFor = (agentDir: string): string => path.join(daemonPaths(agentDir).dir, INDEX_FILENAME);

describe("ReplySentStore", () => {
	test("record then lookup returns the stored text (round trip)", async () => {
		const store = new ReplySentStore({ agentDir: AGENT, fs: new FakeFs() });
		await store.record({ chatId: "42", messageId: 100, text: "hello world" });
		expect(store.lookup({ chatId: "42", messageId: 100 })).toBe("hello world");
	});

	test("lookup of an unrecorded message returns undefined", () => {
		const store = new ReplySentStore({ agentDir: AGENT, fs: new FakeFs() });
		expect(store.lookup({ chatId: "42", messageId: 999 })).toBeUndefined();
	});

	test("entries are isolated by chatId even with the same messageId", async () => {
		const store = new ReplySentStore({ agentDir: AGENT, fs: new FakeFs() });
		await store.record({ chatId: "42", messageId: 7, text: "for chat 42" });
		await store.record({ chatId: "99", messageId: 7, text: "for chat 99" });
		expect(store.lookup({ chatId: "42", messageId: 7 })).toBe("for chat 42");
		expect(store.lookup({ chatId: "99", messageId: 7 })).toBe("for chat 99");
		// A third chat with the same messageId is a miss (keys are chat-scoped).
		expect(store.lookup({ chatId: "7", messageId: 7 })).toBeUndefined();
	});

	test("stored text is capped at 2000 characters; shorter text is kept verbatim", async () => {
		const store = new ReplySentStore({ agentDir: AGENT, fs: new FakeFs() });
		await store.record({ chatId: "42", messageId: 1, text: "x".repeat(5000) });
		const capped = store.lookup({ chatId: "42", messageId: 1 });
		expect(capped).toBe("x".repeat(2000));
		expect(capped!.length).toBe(2000);

		await store.record({ chatId: "42", messageId: 2, text: "short body" });
		expect(store.lookup({ chatId: "42", messageId: 2 })).toBe("short body");
	});

	test("exceeding the 1000-entry cap evicts the oldest entry by timestamp", async () => {
		let clock = 0;
		const fakeFs = new FakeFs();
		const store = new ReplySentStore({ agentDir: AGENT, fs: fakeFs, now: () => ++clock });
		for (let i = 1; i <= 1000; i++) {
			await store.record({ chatId: "42", messageId: i, text: `m${i}` });
		}
		// At exactly the cap the oldest entry is still present.
		expect(store.lookup({ chatId: "42", messageId: 1 })).toBe("m1");

		// One more entry overflows the cap and drops the oldest-by-ts (messageId 1).
		await store.record({ chatId: "42", messageId: 1001, text: "m1001" });
		expect(store.lookup({ chatId: "42", messageId: 1 })).toBeUndefined();
		expect(store.lookup({ chatId: "42", messageId: 2 })).toBe("m2");
		expect(store.lookup({ chatId: "42", messageId: 1001 })).toBe("m1001");

		// The persisted index stays at the cap, at the contract's file path.
		const persisted = JSON.parse(fakeFs.files.get(indexPathFor(AGENT))!) as {
			entries: Record<string, unknown>;
		};
		expect(Object.keys(persisted.entries).length).toBe(1000);
	});

	test("a persist failure is a harmless no-op and never corrupts in-memory state", async () => {
		const fakeFs = new FakeFs();
		const store = new ReplySentStore({ agentDir: AGENT, fs: fakeFs });
		await store.record({ chatId: "42", messageId: 1, text: "kept" });
		expect(store.lookup({ chatId: "42", messageId: 1 })).toBe("kept");

		fakeFs.failWrites = true;
		// Must resolve (not throw) despite the underlying write failure.
		await store.record({ chatId: "42", messageId: 2, text: "dropped" });
		// The failed record left no in-memory trace...
		expect(store.lookup({ chatId: "42", messageId: 2 })).toBeUndefined();
		// ...and did not disturb the previously-committed entry.
		expect(store.lookup({ chatId: "42", messageId: 1 })).toBe("kept");
	});

	test("record persists atomically to the real fs and a fresh store restores it via load()", async () => {
		const agentDir = tempAgentDir();
		const writer = new ReplySentStore({ agentDir });
		await writer.record({ chatId: "42", messageId: 555, text: "# Final\nrich body" });

		// The index landed at the contract's path under the notifications dir.
		expect(fs.existsSync(indexPathFor(agentDir))).toBe(true);

		// A fresh store starts empty and only sees the entry after load().
		const reader = new ReplySentStore({ agentDir });
		expect(reader.lookup({ chatId: "42", messageId: 555 })).toBeUndefined();
		await reader.load();
		expect(reader.lookup({ chatId: "42", messageId: 555 })).toBe("# Final\nrich body");
	});

	test("load() on a missing or corrupt index is a harmless no-op", async () => {
		const fakeFs = new FakeFs();
		const store = new ReplySentStore({ agentDir: AGENT, fs: fakeFs });
		// Missing file: load is a no-op, store stays empty and lookups miss.
		await store.load();
		expect(store.lookup({ chatId: "42", messageId: 1 })).toBeUndefined();

		// Corrupt JSON: load is a no-op and never throws.
		fakeFs.files.set(indexPathFor(AGENT), "{ not valid json");
		await store.load();
		expect(store.lookup({ chatId: "42", messageId: 1 })).toBeUndefined();

		// A prior valid record survives a later corrupt-file load attempt.
		fakeFs.files.delete(indexPathFor(AGENT));
		await store.record({ chatId: "42", messageId: 9, text: "valid" });
		fakeFs.files.set(indexPathFor(AGENT), "corrupt");
		await store.load();
		// load() replaced memory only on success; a corrupt read keeps the record.
		expect(store.lookup({ chatId: "42", messageId: 9 })).toBe("valid");
	});
});
