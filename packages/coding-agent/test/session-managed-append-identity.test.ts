import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import {
	ManagedAppendIdentityMismatchError,
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-append-identity-"));
	roots.push(root);
	return root;
}

it("throws the typed pre-write rejection when the append expectation no longer matches", async () => {
	const root = await makeRoot();
	const store = new ManagedSessionDescendantStore(managedDirectoryRoot(root), root);
	try {
		await Bun.write(path.join(root, "session.jsonl"), "original\n");
		const expected = store.captureBoundedAppendExpectation("session.jsonl");
		if (!expected) throw new Error("Missing expectation");
		await Bun.write(path.join(root, "successor"), "winner\n");
		await fs.rename(path.join(root, "successor"), path.join(root, "session.jsonl"));
		expect(() => store.appendExpectedSync("session.jsonl", Buffer.from("loser\n"), expected)).toThrow(
			ManagedAppendIdentityMismatchError,
		);
		expect(await Bun.file(path.join(root, "session.jsonl")).text()).toBe("winner\n");
	} finally {
		store.close();
	}
});

it.each([
	false,
	true,
])("disposes a rejected append without rewriting the winner (flush first: %s)", async flushFirst => {
	const root = await makeRoot();
	const manager = SessionManager.create(root, SessionManager.managedDestination(root, path.join(root, "agent")));
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	const session = new AgentSession({
		agent: new Agent(),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
	});
	try {
		manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing transcript");
		const winner = await Bun.file(file).text();
		await Bun.write(`${file}.successor`, winner);
		await fs.rename(`${file}.successor`, file);
		expect(() => manager.appendMessage({ role: "user", content: "loser", timestamp: 2 })).toThrow(
			ManagedAppendIdentityMismatchError,
		);
		if (flushFirst) expect(await manager.flushAndCloseStrict()).toEqual({ kind: "closed" });
		await expect(session.dispose()).resolves.toBeUndefined();
		expect(await manager.closeStrict()).toEqual({ kind: "closed" });
		expect(await Bun.file(file).text()).toBe(winner);
	} finally {
		await session.dispose();
		auth.close();
	}
});

it("retains close_unknown for a genuine managed append I/O failure", async () => {
	const root = await makeRoot();
	const manager = SessionManager.create(root, SessionManager.managedDestination(root, path.join(root, "agent")));
	manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
	await manager.ensureOnDisk();
	const failure = new Error("uncertain write");
	const spy = vi
		.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
		.mockImplementation(() => {
			throw failure;
		});
	expect(() => manager.appendMessage({ role: "user", content: "loser", timestamp: 2 })).toThrow(failure);
	spy.mockRestore();
	expect(await manager.closeStrict()).toEqual({ kind: "close_unknown", error: failure });
});
