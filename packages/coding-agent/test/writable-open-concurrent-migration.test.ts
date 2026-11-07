import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedSessionDescendantStore } from "../src/session/internal/managed-session-storage";
import { type SessionDestination, SessionManager } from "../src/session/session-manager";

// Two opens of one legacy transcript both owe a migration rewrite, and whichever publishes
// second would drop the other's result. These cases cover the file-level hazard: the loser
// declines, the winner's entries survive, and a refused publish leaves the transcript
// byte-identical so a later open can still migrate it.
//
// Lease exclusion at this call site is NOT pinned here: the cases pass with the lease
// removed, because the bind-time digest is what makes the loser decline. Exclusion and
// bounded contention are covered by managed-session-transaction*.test.ts.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function legacyTranscript(): Promise<{
	file: string;
	destination: SessionDestination;
	entryIds: string[];
	headerId: string;
}> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-concurrent-migration-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	// Two entries with distinct ids, so "entries intact" is checkable rather than a length.
	const first = writer.appendMessage({ role: "user" as const, content: "one", timestamp: 1 });
	const second = writer.appendMessage({ role: "user" as const, content: "two", timestamp: 2 });
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	// Rewind the header so the next writable open owes a migration.
	const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
	const header = JSON.parse(lines[0]!) as Record<string, unknown>;
	header.version = 1;
	await Bun.write(file, `${JSON.stringify(header)}\n${lines.slice(1).join("\n")}\n`);
	return { file, destination, entryIds: [first, second], headerId: header.id as string };
}

describe("concurrent writable-open migration", () => {
	it("lets exactly one opener publish and makes the other re-read the winner's transcript", async () => {
		const { file, destination, entryIds, headerId } = await legacyTranscript();
		const first = await SessionManager.open(file, destination);
		const second = await SessionManager.open(file, destination);
		managers.push(first, second);

		const outcomes = [await first.finalizeWritableOpen(), await second.finalizeWritableOpen()];
		expect(outcomes.filter(outcome => outcome === "published")).toHaveLength(1);
		expect(outcomes.filter(outcome => outcome === "stale")).toHaveLength(1);

		// Both entries survive, under the same session identity. Migration v1→v2 legitimately
		// regenerates entry ids, so what identity means here is the header plus the entries'
		// count and content.
		const read = await first.captureCommittedSnapshot();
		if (read.kind !== "snapshot") throw new Error(`expected a committed snapshot, got ${read.kind}`);
		expect(read.snapshot.entryIds).toHaveLength(entryIds.length);
		expect(read.snapshot.sessionId).toBe(headerId);
		const migrated = await Bun.file(file).text();
		for (const content of ["one", "two"]) expect(migrated).toContain(`"content":"${content}"`);

		// The loser really does see the winner's transcript when it re-reads, which is why
		// "stale" is the correct outcome rather than a silent success.
		const loser = outcomes[0] === "stale" ? first : second;
		const loserRead = await loser.captureCommittedSnapshot();
		if (loserRead.kind !== "snapshot") throw new Error("expected a committed snapshot");
		expect(loserRead.snapshot.digest).toBe(read.snapshot.digest);
		expect(loserRead.snapshot.entryIds).toEqual(read.snapshot.entryIds);
	});

	it("leaves the transcript byte-identical when the publish is refused, and a later open migrates it", async () => {
		const { file, destination, entryIds } = await legacyTranscript();
		const failing = await SessionManager.open(file, destination);
		managers.push(failing);
		const before = await Bun.file(file).bytes();
		const directoryBefore = (await fs.readdir(path.dirname(file))).filter(
			entry => !entry.includes(".gjc-managed-session-internal"),
		);
		vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceExpectedIdentitySync").mockImplementation(() => {
			throw new Error("durability_failed");
		});

		await expect(failing.finalizeWritableOpen()).rejects.toThrow(/durability_failed/u);
		// Refused before the replacement landed: identical bytes and no staged debris.
		expect(await Bun.file(file).bytes()).toEqual(before);
		const directoryAfter = (await fs.readdir(path.dirname(file))).filter(
			entry => !entry.includes(".gjc-managed-session-internal"),
		);
		expect(directoryAfter).toEqual(directoryBefore);

		vi.restoreAllMocks();
		const recovered = await SessionManager.open(file, destination);
		managers.push(recovered);
		expect(await recovered.finalizeWritableOpen()).toBe("published");
		const read = await recovered.captureCommittedSnapshot();
		if (read.kind !== "snapshot") throw new Error("expected a committed snapshot");
		// Still readable with the same entries, now at the migrated version.
		expect(read.snapshot.entryIds).toHaveLength(entryIds.length);
		const recoveredText = await Bun.file(file).text();
		for (const content of ["one", "two"]) expect(recoveredText).toContain(`"content":"${content}"`);
		const header = JSON.parse((await Bun.file(file).text()).split("\n")[0]!) as Record<string, unknown>;
		expect(header.version).toBeGreaterThan(1);
	});
});
