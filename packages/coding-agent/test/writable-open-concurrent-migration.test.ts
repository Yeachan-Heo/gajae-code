import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { type SessionDestination, SessionManager } from "../src/session/session-manager";

// Migration is driven by the entries an open read, so two opens of the same legacy
// transcript both want to publish. Exactly one may win; the loser has to report that the
// transcript moved instead of rewriting over the winner. A publish that dies half-way
// must leave a readable legacy transcript that a later open can still migrate.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function legacyTranscript(): Promise<{ file: string; destination: SessionDestination; cwd: string }> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-concurrent-migration-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	writer.appendMessage({ role: "user" as const, content: "root", timestamp: 1 });
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	// Rewind the header so the next writable open owes a migration.
	const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
	const header = JSON.parse(lines[0]!) as Record<string, unknown>;
	header.version = 1;
	await Bun.write(file, `${JSON.stringify(header)}\n${lines.slice(1).join("\n")}\n`);
	return { file, destination, cwd };
}

async function headerVersion(file: string): Promise<unknown> {
	const header = JSON.parse((await Bun.file(file).text()).split("\n")[0]!) as Record<string, unknown>;
	return header.version;
}

describe("concurrent writable-open migration", () => {
	it("lets exactly one opener publish and makes the other re-read", async () => {
		const { file, destination } = await legacyTranscript();
		const first = await SessionManager.open(file, destination);
		const second = await SessionManager.open(file, destination);
		managers.push(first, second);

		const outcomes = [await first.finalizeWritableOpen(), await second.finalizeWritableOpen()];
		// One published; the other must not rewrite the transcript the winner produced.
		expect(outcomes.filter(outcome => outcome === "published")).toHaveLength(1);
		expect(outcomes.filter(outcome => outcome === "stale")).toHaveLength(1);

		expect(await headerVersion(file)).toBeGreaterThan(1);
		// The winner's content survived: migration must not drop entries.
		const read = await first.captureCommittedSnapshot();
		if (read.kind !== "snapshot") throw new Error(`expected a committed snapshot, got ${read.kind}`);
		expect(read.snapshot.entryIds.length).toBeGreaterThan(0);
		// The published transcript still parses as a session, not as a stray copy.
		expect(read.snapshot.sessionId).toBeString();
	});

	it("leaves a readable legacy transcript when the publish fails, and a later open migrates it", async () => {
		const { file, destination } = await legacyTranscript();
		const failing = await SessionManager.open(file, destination);
		managers.push(failing);
		vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceExpectedIdentitySync").mockImplementation(() => {
			throw new Error("durability_failed");
		});

		await expect(failing.finalizeWritableOpen()).rejects.toThrow(/durability_failed/u);
		// The failed publish must not leave a half-migrated transcript behind.
		expect(await headerVersion(file)).toBe(1);
		const stillReadable = await SessionManager.open(file, destination);
		managers.push(stillReadable);
		expect(stillReadable.getEntries().length).toBeGreaterThan(0);

		vi.restoreAllMocks();
		expect(await stillReadable.finalizeWritableOpen()).toBe("published");
		expect(await headerVersion(file)).toBeGreaterThan(1);
	});
});
