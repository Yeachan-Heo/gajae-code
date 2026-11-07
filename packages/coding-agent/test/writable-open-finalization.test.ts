import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionDestination, SessionManager } from "../src/session/session-manager";

// A writable open may owe the transcript a migration rewrite. Publishing that rewrite is
// driven by the entries this process read, so it must happen under the session lease and
// only while the transcript is still the one that was read; otherwise an open would
// overwrite whatever another writer committed in the meantime.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<{ cwd: string; agentDir: string; destination: SessionDestination }> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-writable-open-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	return { cwd, agentDir, destination: SessionManager.managedDestination(cwd, agentDir) };
}

function user(text: string, timestamp: number) {
	return { role: "user" as const, content: text, timestamp };
}

async function persistedTranscript(
	destination: SessionDestination,
	cwd: string,
): Promise<{ file: string; writer: SessionManager }> {
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	writer.appendMessage(user("root", 1));
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	return { file, writer };
}

describe("writable open finalization", () => {
	it("publishes nothing for a session with no pending rewrite", async () => {
		const { cwd, destination } = await makeWorkspace();
		const { file } = await persistedTranscript(destination, cwd);
		const before = await Bun.file(file).text();

		const reader = await SessionManager.open(file, destination);
		managers.push(reader);
		expect(await reader.finalizeWritableOpen()).toBe("unchanged");
		expect(await Bun.file(file).text()).toBe(before);
	});

	it("publishes pending migration under the lease", async () => {
		const { cwd, destination } = await makeWorkspace();
		const { file } = await persistedTranscript(destination, cwd);
		// Rewind the header so this transcript needs migration on the next writable open.
		const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
		const header = JSON.parse(lines[0]!) as Record<string, unknown>;
		header.version = 1;
		await Bun.write(file, `${JSON.stringify(header)}\n${lines.slice(1).join("\n")}\n`);
		const before = await Bun.file(file).text();

		const reader = await SessionManager.open(file, destination);
		managers.push(reader);
		expect(await reader.finalizeWritableOpen()).toBe("published");
		const after = await Bun.file(file).text();
		// Recorded gap, not desired behaviour: the lease-bound rewrite runs and the outcome
		// reports it, but the persisted header keeps the old version, so the migration is not
		// durable yet. Pinned so the migration-durability follow-up cannot close by accident.
		expect(after).toBe(before);
		// Same gap seen from the other side: the rewrite debt is never cleared, so a second
		// writable open repeats the publish. Fixing the durability above fixes this too.
		expect(await reader.finalizeWritableOpen()).toBe("published");
	});

	it("is a no-op for a destination that is not managed", async () => {
		const manager = SessionManager.inMemory();
		managers.push(manager);
		expect(await manager.finalizeWritableOpen()).toBe("unchanged");
	});

	it("refuses to publish when another writer moved the transcript first", async () => {
		const { cwd, destination } = await makeWorkspace();
		const { file, writer } = await persistedTranscript(destination, cwd);
		const second = await SessionManager.open(file, destination);
		managers.push(second);

		// The same transcript gains an append after this open read it.
		writer.appendMessage(user("from writer", 2));
		await writer.flush();

		// Publishing now would drop that append, so the open must report staleness instead.
		expect(await second.finalizeWritableOpen()).toBe("stale");
		expect(await Bun.file(file).text()).toContain("from writer");
	});

	it("reports an uninterpretable transcript without publishing", async () => {
		const { cwd, destination } = await makeWorkspace();
		const { file } = await persistedTranscript(destination, cwd);
		const reader = await SessionManager.open(file, destination);
		managers.push(reader);
		const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
		const header = JSON.parse(lines[0]!) as Record<string, unknown>;
		header.version = 99;
		await Bun.write(file, `${JSON.stringify(header)}\n${lines.slice(1).join("\n")}\n`);

		expect(await reader.finalizeWritableOpen()).toBe("unsupported");
		expect(await Bun.file(file).text()).toContain('"version":99');
	});
});
