import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ManagedCommittedMutationError,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import { SessionAppendPersistenceError, type SessionDestination, SessionManager } from "../src/session/session-manager";

// Three layers: the committed transcript, this process's unpublished entries, and the
// cursor. Reading them together is what lets a later refresh decide what to do with a
// cursor that points at something nobody else can see. An unreadable committed layer is
// reported as such, because absence of evidence is not an empty session.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeManager(): Promise<{ manager: SessionManager; destination: SessionDestination }> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-local-overlay-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	return { manager, destination };
}

function user(text: string, timestamp: number) {
	return { role: "user" as const, content: text, timestamp };
}

/** Inject a committed-uncertain failure; `write` decides whether bytes land first. */
function injectUncertain(write: boolean): () => void {
	const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
	const spy = vi
		.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
		.mockImplementation(function (this: ManagedSessionDescendantStore, ...args: Parameters<typeof original>) {
			if (write) original.apply(this, args);
			throw new ManagedCommittedMutationError("append", new Error("committed_outcome_uncertain"));
		});
	return () => spy.mockRestore();
}

function attempt(manager: SessionManager, text: string, timestamp: number): SessionAppendPersistenceError {
	let thrown: unknown;
	try {
		manager.appendMessage(user(text, timestamp));
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(SessionAppendPersistenceError);
	return thrown as SessionAppendPersistenceError;
}

describe("local transcript overlay", () => {
	it("reports nothing unpublished once everything is committed", async () => {
		const { manager } = await makeManager();
		const id = manager.appendMessage(user("root", 1));
		await manager.ensureOnDisk();

		const overlay = await manager.captureLocalOverlay();
		if (overlay.kind !== "overlay") throw new Error("expected an overlay");
		expect(overlay.unpublishedIds).toEqual([]);
		expect(overlay.cursorId).toBe(id);
		expect(overlay.cursorUnpublished).toBe(false);
	});

	it("reports every entry as unpublished before anything is published", async () => {
		const { manager } = await makeManager();
		const first = manager.appendMessage(user("one", 1));
		const second = manager.appendMessage(user("two", 2));

		const overlay = await manager.captureLocalOverlay();
		if (overlay.kind !== "overlay") throw new Error("expected an overlay");
		// Nothing on disk, so the committed layer is genuinely empty for this session.
		expect(overlay.read.kind).toBe("absent");
		// Two entries, in resident order: a one-entry case cannot show the plural contract.
		expect(overlay.unpublishedIds).toEqual([first, second]);
		expect(overlay.cursorId).toBe(second);
		expect(overlay.cursorUnpublished).toBe(true);
	});

	it("treats a retained append whose write never landed as unpublished", async () => {
		const { manager } = await makeManager();
		const rootId = manager.appendMessage(user("root", 1));
		await manager.ensureOnDisk();
		// Preflight failure shape: no bytes written, retention still applies. Linux-only
		// retained-authority path, as noted in the retention test.
		const restore = injectUncertain(false);
		const failure = attempt(manager, "attempt", 2);
		restore();

		const overlay = await manager.captureLocalOverlay();
		if (overlay.kind !== "overlay") throw new Error("expected an overlay");
		expect(overlay.unpublishedIds).toEqual([failure.entryId]);
		expect(overlay.cursorId).toBe(failure.entryId);
		expect(overlay.cursorUnpublished).toBe(true);
		if (overlay.read.kind !== "snapshot") throw new Error("expected a committed snapshot");
		expect(overlay.read.snapshot.entryIds).toEqual([rootId]);
	});

	it("treats a retained append whose write landed as committed, not unpublished", async () => {
		const { manager } = await makeManager();
		const rootId = manager.appendMessage(user("root", 1));
		await manager.ensureOnDisk();
		const restore = injectUncertain(true);
		const failure = attempt(manager, "attempt", 2);
		restore();

		const overlay = await manager.captureLocalOverlay();
		if (overlay.kind !== "overlay") throw new Error("expected an overlay");
		// The bytes are in the transcript, so the id is committed even though the manager
		// still treats the outcome as uncertain and keeps the entry for a rewrite.
		expect(overlay.unpublishedIds).toEqual([]);
		expect(overlay.cursorUnpublished).toBe(false);
		if (overlay.read.kind !== "snapshot") throw new Error("expected a committed snapshot");
		expect(overlay.read.snapshot.entryIds).toEqual([rootId, failure.entryId]);
	});

	it("makes no claim when the committed transcript cannot be interpreted", async () => {
		const { manager } = await makeManager();
		manager.appendMessage(user("root", 1));
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
		const header = JSON.parse(lines[0]!) as Record<string, unknown>;
		header.version = 99;
		await Bun.write(file, `${JSON.stringify(header)}\n${lines.slice(1).join("\n")}\n`);

		const overlay = await manager.captureLocalOverlay();
		// Not "every local entry is unpublished": the transcript was never read.
		expect(overlay.kind).toBe("unreadable");
		expect(overlay.read.kind).toBe("unsupported");
	});

	it("does not label another process's committed entries as unpublished", async () => {
		const { manager, destination } = await makeManager();
		const rootId = manager.appendMessage(user("root", 1));
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		const reader = await SessionManager.open(file, destination);
		managers.push(reader);

		const overlay = await reader.captureLocalOverlay();
		if (overlay.kind !== "overlay") throw new Error("expected an overlay");
		expect(overlay.read.kind).toBe("snapshot");
		if (overlay.read.kind !== "snapshot") throw new Error("expected a committed snapshot");
		expect(overlay.read.snapshot.entryIds).toEqual([rootId]);
		expect(overlay.cursorId).toBe(rootId);
		expect(overlay.unpublishedIds).toEqual([]);
		expect(overlay.cursorUnpublished).toBe(false);
	});
});
