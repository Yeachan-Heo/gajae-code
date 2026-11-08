import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

// Staged default-model selection publishes through a whole-file replacement rather than an
// append, which is the other half of the mutation surface. On a shared transcript that
// matters: a replacement materializes the promoting process's resident entries, so if it ran
// against a transcript another opener had advanced, it would delete that work.

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
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-model-promotion-"));
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

describe("staged default model selection on a shared transcript", () => {
	it("does not replace a transcript another opener already advanced", async () => {
		const { file, first, second, destination } = await sharedOpens();
		// The first opener advances the transcript after the second one bound to it.
		first.appendMessage({ role: "user" as const, content: "from first", timestamp: 2 });
		await first.flush();
		const advanced = await Bun.file(file).text();
		expect(advanced).toContain("from first");

		// The second opener's staged promotion materializes its own resident entries. It must
		// not publish that view over the transcript it no longer matches.
		const stage = await second.stageDefaultModelSelection("anthropic/claude-second", "high", {
			appendThinkingLevel: true,
		});
		const promotion = second.promoteDefaultModelSelection(stage);
		// Pin the mechanism, not just "it was refused": the managed replacement is gated by
		// the expected-identity check, so a refusal that never reached that check (a failed
		// transition preparation, a missing staged replacement) would satisfy the weaker
		// `not_promoted`/`unknown` union without proving the fence ran.
		expect(promotion.kind).toBe("unknown");
		if (promotion.kind !== "unknown") throw new Error(`unexpected promotion outcome: ${promotion.kind}`);
		expect(promotion.error.message).toBe("managed_replace_identity_mismatch");

		// Nothing at all was published: the bytes are exactly what the refusing opener found,
		// so the refused selection's thinking-level entry cannot have leaked in either.
		const afterPromotion = await Bun.file(file).text();
		expect(afterPromotion).toBe(advanced);
		expect(afterPromotion).toContain("from first");
		expect(afterPromotion).not.toContain("claude-second");
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(JSON.stringify(reopened.getEntries())).toContain("from first");
	});

	it("still promotes for the opener that owns the transcript", async () => {
		const { file, first, destination } = await sharedOpens();
		const stage = await first.stageDefaultModelSelection("anthropic/claude-first", "high", {
			appendThinkingLevel: true,
		});
		expect(first.promoteDefaultModelSelection(stage).kind).toBe("promoted");
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		const entries = reopened.getEntries();
		// The stage writes a temporary and a default role with the same model, so asserting the
		// model alone would pass on the temporary entry. The default role is what takes effect.
		expect(entries).toContainEqual(
			expect.objectContaining({ type: "model_change", role: "default", model: "anthropic/claude-first" }),
		);
		expect(entries).toContainEqual(expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "high" }));
		// A whole-file replacement has to carry the entries that were already there.
		expect(JSON.stringify(entries)).toContain("shared root");
	});
});
