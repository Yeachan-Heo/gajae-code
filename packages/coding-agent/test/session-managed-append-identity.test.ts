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

it("keeps the successor's transcript and resumes it after a rejected append", async () => {
	const root = await makeRoot();
	const agentDir = path.join(root, "agent");
	const destination = SessionManager.managedDestination(root, agentDir);
	const manager = SessionManager.create(root, destination);
	let sessionFile: string | undefined;
	try {
		manager.appendMessage({ role: "user", content: "kept-before-resume", timestamp: 1 });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing transcript");
		sessionFile = file;

		// A second process resumes the same transcript and appends through its own
		// writer. Reproduces the concurrent-writer condition behind the original
		// `managed_append_identity_mismatch` crash without touching the filesystem
		// outside the store's own append path.
		const successor = await SessionManager.open(file, destination);
		try {
			successor.appendMessage({ role: "user", content: "appended-by-successor", timestamp: 2 });
			await successor.flush();
		} finally {
			await successor.close();
		}
		const winnerBytes = await Bun.file(file).text();

		expect(() => manager.appendMessage({ role: "user", content: "rejected-loser", timestamp: 3 })).toThrow(
			ManagedAppendIdentityMismatchError,
		);
		expect(manager.getAppendIdentityMismatch()).toBeInstanceOf(ManagedAppendIdentityMismatchError);
		// The fence is pre-write: the loser wrote no bytes and the winner's records stay.
		expect(await Bun.file(file).text()).toBe(winnerBytes);
		expect(await manager.closeStrict()).toEqual({ kind: "closed" });
	} finally {
		await manager.close().catch(() => {});
	}

	// Resume path: a fresh process reads every record the winner persisted.
	if (!sessionFile) throw new Error("Missing transcript");
	const resumed = await SessionManager.open(sessionFile, destination);
	try {
		const userTexts = resumed
			.getEntries()
			.flatMap(entry =>
				entry.type === "message" && entry.message.role === "user" ? [String(entry.message.content)] : [],
			);
		expect(userTexts).toEqual(["kept-before-resume", "appended-by-successor"]);
	} finally {
		await resumed.close();
	}
});

it("warns the operator once when the managed append fence rejects", async () => {
	const root = await makeRoot();
	const manager = SessionManager.create(root, SessionManager.managedDestination(root, path.join(root, "agent")));
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	const session = new AgentSession({
		agent: new Agent(),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
	});
	const notices: { level: string; message: string; source?: string }[] = [];
	session.subscribe(event => {
		if (event.type === "notice") notices.push({ level: event.level, message: event.message, source: event.source });
	});
	try {
		manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing transcript");
		const winner = await Bun.file(file).text();
		await Bun.write(`${file}.successor`, winner);
		await fs.rename(`${file}.successor`, file);

		// Every later append fails against the same sticky error; the operator is
		// told once instead of the session running on without a transcript.
		expect(() => manager.appendMessage({ role: "user", content: "loser-1", timestamp: 2 })).toThrow(
			ManagedAppendIdentityMismatchError,
		);
		expect(() => manager.appendMessage({ role: "user", content: "loser-2", timestamp: 3 })).toThrow(
			ManagedAppendIdentityMismatchError,
		);
		await Bun.sleep(10);
		expect(notices).toEqual([
			{
				level: "error",
				message: new ManagedAppendIdentityMismatchError("session.jsonl").operatorMessage,
				source: "session-persistence",
			},
		]);
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
