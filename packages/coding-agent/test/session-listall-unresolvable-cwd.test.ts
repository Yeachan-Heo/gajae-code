import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveResumableSession, SessionManager } from "../src/session/session-manager";

/**
 * Write a real managed transcript through the normal session lifecycle so the
 * scope directory, its binding marker, and its ACL state all match production.
 */
async function writeManagedSession(cwd: string, agentDir: string): Promise<string> {
	const manager = SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir));
	await manager.ensureOnDisk();
	await manager.flush();
	const filePath = manager.getSessionFile();
	await manager.close();
	if (!filePath) throw new Error("Expected a managed transcript path");
	return filePath;
}

describe("global session listing when a recorded workspace disappears", () => {
	it("lists a managed transcript whose workspace still exists", async () => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "gjc-listall-live-agent-"));
		const cwd = await mkdtemp(path.join(tmpdir(), "gjc-listall-live-cwd-"));
		const transcript = await writeManagedSession(cwd, agentDir);

		const all = await SessionManager.listAll(undefined, agentDir);
		expect(all.map(session => session.path)).toContain(transcript);
	});

	it("keeps a readable transcript after its recorded workspace is removed", async () => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "gjc-listall-gone-agent-"));
		const cwd = await mkdtemp(path.join(tmpdir(), "gjc-listall-gone-cwd-"));
		const transcript = await writeManagedSession(cwd, agentDir);

		// The workspace is deleted, renamed, or unmounted. The transcript is still
		// intact on disk, so the session must remain reachable.
		await rm(cwd, { recursive: true, force: true });

		const all = await SessionManager.listAll(undefined, agentDir);
		expect(all.map(session => session.path)).toContain(transcript);

		const resumed = await resolveResumableSession(
			path.basename(transcript, ".jsonl").split("_").pop() ?? "",
			tmpdir(),
			undefined,
			undefined,
			agentDir,
		);
		expect(resumed?.session.path).toBe(transcript);
	});
});
