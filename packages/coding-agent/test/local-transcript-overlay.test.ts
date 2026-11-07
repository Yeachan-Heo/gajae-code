import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ManagedCommittedMutationError,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import { type SessionDestination, SessionManager } from "../src/session/session-manager";

// Three layers: the committed transcript, this process's unpublished entries, and the
// cursor. Reading them together is what lets a later refresh decide what to do with a
// cursor that points at something nobody else can see.

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

describe("local transcript overlay", () => {
	it("reports nothing unpublished once everything is committed", async () => {
		const { manager } = await makeManager();
		const id = manager.appendMessage({ role: "user" as const, content: "root", timestamp: 1 });
		await manager.ensureOnDisk();

		const overlay = await manager.captureLocalOverlay();
		expect(overlay.unpublishedIds).toEqual([]);
		expect(overlay.cursorId).toBe(id);
		expect(overlay.cursorUnpublished).toBe(false);
	});

	it("reports every entry as unpublished before anything is published", async () => {
		const { manager } = await makeManager();
		const id = manager.appendMessage({ role: "user" as const, content: "root", timestamp: 1 });

		const overlay = await manager.captureLocalOverlay();
		// Nothing on disk, so the committed layer is empty and the local layer is all there is.
		expect(overlay.read.kind).toBe("absent");
		expect(overlay.unpublishedIds).toEqual([id]);
		expect(overlay.cursorUnpublished).toBe(true);
	});

	it("marks a retained committed-uncertain entry and the cursor on it", async () => {
		const { manager } = await makeManager();
		const rootId = manager.appendMessage({ role: "user" as const, content: "root", timestamp: 1 });
		await manager.ensureOnDisk();
		// No bytes are written: this is the shape where the store could not report an
		// identity, so the entry is retained while the transcript never gains it.
		vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementation(() => {
			throw new ManagedCommittedMutationError("append", new Error("committed_outcome_uncertain"));
		});
		try {
			manager.appendMessage({ role: "user" as const, content: "attempt", timestamp: 2 });
		} catch {}
		const overlay = await manager.captureLocalOverlay();
		const retainedId = overlay.unpublishedIds.at(-1) ?? "";

		expect(retainedId).not.toBe("");
		expect(retainedId).not.toBe(rootId);
		expect(overlay.unpublishedIds).toEqual([retainedId]);
		// The cursor advanced onto an entry only this process can see.
		expect(overlay.cursorId).toBe(retainedId);
		expect(overlay.cursorUnpublished).toBe(true);
		if (overlay.read.kind !== "snapshot") throw new Error("expected a committed snapshot");
		expect(overlay.read.snapshot.entryIds).toEqual([rootId]);
	});

	it("does not label another process's committed entry as unpublished", async () => {
		const { manager, destination } = await makeManager();
		manager.appendMessage({ role: "user" as const, content: "root", timestamp: 1 });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile();
		if (!file) throw new Error("expected a transcript path");
		const reader = await SessionManager.open(file, destination);
		managers.push(reader);
		const readerOverlay = await reader.captureLocalOverlay();
		expect(readerOverlay.unpublishedIds).toEqual([]);
		expect(readerOverlay.cursorUnpublished).toBe(false);
	});
});
