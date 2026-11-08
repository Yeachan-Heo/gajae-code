import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ManagedAppendIdentityMismatchError } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";

// Model-selection, thinking-level and service-tier changes are entries, so they funnel
// through the same identity-checked append as a message. Title, star and cwd are
// `header_patch` records on that same identity fence and are not exercised by this file.
//
// What this pins for a second opener: its change is rejected before anything is written, the
// first opener's change survives and is what a fresh reader sees, and the rejection latches
// the manager. It does not pin that the family can be published into a shared transcript -
// there is no shared seam for it, and the seam that exists is message-only.

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
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-model-change-"));
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

describe("model, thinking and service-tier changes from a second opener", () => {
	it("rejects the stale model change and keeps the committed one", async () => {
		const { file, first, second, destination } = await sharedOpens();
		first.appendModelChange("anthropic/claude-first");
		await first.flush();

		const beforeSecond = await Bun.file(file).text();
		expect(() => second.appendModelChange("openai/gpt-second")).toThrow(ManagedAppendIdentityMismatchError);
		// Nothing of the rejected change reached the transcript.
		expect(await Bun.file(file).text()).toBe(beforeSecond);
		expect(beforeSecond).not.toContain("gpt-second");

		// The committed change is what a fresh reader sees, so the rejection lost no state.
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		const models = reopened.getEntries().flatMap(entry => (entry.type === "model_change" ? [entry.model] : []));
		expect(models).toEqual(["anthropic/claude-first"]);
	});

	it("latches the manager so a later shared publish is refused", async () => {
		const { first, second } = await sharedOpens();
		first.appendThinkingLevelChange("high");
		await first.flush();
		expect(() => second.appendThinkingLevelChange("low")).toThrow(ManagedAppendIdentityMismatchError);
		// The family has no shared seam of its own, so the only path out for this opener is a
		// reopen. Until then the shared message seam refuses it too, because the rejection
		// latched persistence.
		expect(
			await second.appendMessageSharingSession({ role: "user" as const, content: "from B", timestamp: 3 }),
		).toMatchObject({ kind: "stale", reason: "persistence_latched" });
	});

	it("rejects a service-tier change the same way", async () => {
		const { file, first, second } = await sharedOpens();
		first.appendServiceTierChange("priority");
		await first.flush();
		const before = await Bun.file(file).text();
		expect(() => second.appendServiceTierChange("flex")).toThrow(ManagedAppendIdentityMismatchError);
		expect(await Bun.file(file).text()).toBe(before);
	});
});
