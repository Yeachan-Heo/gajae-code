import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager, SharedSessionMutationUnsupportedError } from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fresh() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-move-mutation-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const a = SessionManager.create(cwd, destination);
	managers.push(a);
	return { root, cwd, destination, a, file: a.getSessionFile()! };
}

describe("session move mutation admission", () => {
	it("refuses full transcript rewrite during cwd transition under shared admission", async () => {
		const { a, file, destination } = await fresh();
		// Create shared admission by opening a second manager on the same session
		const first = await a.appendMessageSharingSession(user("root"));
		if (first.kind !== "committed") throw new Error(first.kind);
		const b = await SessionManager.open(file, destination);
		managers.push(b);
		const sibling = await b.appendMessageSharingSession(user("B sibling"));
		if (sibling.kind !== "committed") throw new Error(sibling.kind);
		// Now 'a' should be under shared admission
		const own = await a.appendMessageSharingSession(user("A sibling"));
		if (own.kind !== "committed") throw new Error(own.kind);

		const nextCwd = path.join(path.dirname(a.getCwd()), "other-workspace");
		await fs.mkdir(nextCwd);

		// Try to perform a transcript rewrite during the cwd transition.
		// Rewrite operations ("rewrite transcript", "full transcript publication") should be
		// blocked by shared admission, even during an exclusive cwd transition.
		// Only operations the move itself performs should be allowed: "move session",
		// "append header patch", and "persist patches".
		let threwError: Error | null = null;
		try {
			await a.runExclusiveCwdMoveTransition(async () => {
				await a.rewriteEntries();
			});
		} catch (err) {
			threwError = err instanceof Error ? err : new Error(String(err));
		}

		// The rewrite should be blocked by shared admission because rewrite operations
		// are not in the allowed operations list during cwd transitions.
		expect(threwError).toBeInstanceOf(SharedSessionMutationUnsupportedError);
	});
});
