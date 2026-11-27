import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

// Title and star are `header_patch` records, not entries, but they publish through the same
// identity-checked funnel. This pins what a second opener gets: its patch is refused before
// anything is written, its in-memory header is rolled back rather than left showing a value
// the transcript does not carry, and the first opener's value survives a reopen.

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function sharedOpens(): Promise<{
	file: string;
	first: SessionManager;
	second: SessionManager;
	destination: ReturnType<typeof SessionManager.managedDestination>;
}> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-header-patch-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	writer.appendMessage({ role: "user" as const, content: "shared root", timestamp: 1 });
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	const first = await SessionManager.open(file, destination);
	const second = await SessionManager.open(file, destination);
	managers.push(first, second);
	return { file, first, second, destination };
}

describe("header patch from a second opener", () => {
	it("refuses the stale title and rolls its own header back", async () => {
		const { file, first, second, destination } = await sharedOpens();
		expect(await first.setSessionName("first title", "user")).toBe(true);
		const committed = await Bun.file(file).text();

		await expect(second.setSessionName("second title", "user")).rejects.toBeInstanceOf(
			ManagedAppendIdentityMismatchError,
		);
		// The refused patch is not written, and the opener that tried it drops it instead of
		// showing a title the transcript never received.
		expect(await Bun.file(file).text()).toBe(committed);
		expect(second.getSessionName()).toBeUndefined();

		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(reopened.getSessionName()).toBe("first title");
	});

	it("refuses the stale star and restores its own unstarred value", async () => {
		const { file, first, second, destination } = await sharedOpens();
		expect(await first.setSessionStarred(true)).toBe(true);
		const committed = await Bun.file(file).text();

		await expect(second.setSessionStarred(true)).rejects.toBeInstanceOf(ManagedAppendIdentityMismatchError);
		expect(await Bun.file(file).text()).toBe(committed);
		// This opener reverts to its own pre-attempt value; it does not converge on the
		// committed one, which only a reopen reads. This path rolls back unconditionally and is
		// unchanged by the fix - it is pinned here as behaviour, not as evidence of it.
		expect(second.isSessionStarred()).toBe(false);

		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(reopened.isSessionStarred()).toBe(true);
	});
});
