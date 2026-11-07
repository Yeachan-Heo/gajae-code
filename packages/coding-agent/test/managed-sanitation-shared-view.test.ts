import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

// Sanitizing loaded OpenAI-responses replay metadata mutates resident entries. On the default
// managed open the persist half is skipped, so this entry point does not publish synchronously:
// the signature is stripped for the model while the transcript keeps it and re-strips it on
// every open. The bounded managed-resume lane is the opposite - there the same sanitation arms
// rewrite debt and publishes on the next persist - and is not exercised here.

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
	beforeOpen: string;
	afterFirstOpen: string;
}> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-sanitation-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	writer.appendMessage({
		role: "assistant" as const,
		content: [{ type: "thinking" as const, thinking: "kept reasoning", thinkingSignature: "signature-to-strip" }],
		providerPayload: { type: "openaiResponsesHistory" as const, items: [] },
		timestamp: 1,
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
	});
	await writer.ensureOnDisk();
	const file = writer.getSessionFile();
	if (!file) throw new Error("expected a transcript path");
	// Baseline before any open: a write performed during load would otherwise be inside it.
	const beforeOpen = await Bun.file(file).text();
	const first = await SessionManager.open(file, destination);
	const afterFirstOpen = await Bun.file(file).text();
	const second = await SessionManager.open(file, destination);
	managers.push(first, second);
	return { file, first, second, destination, beforeOpen, afterFirstOpen };
}

describe("sanitation on a shared transcript", () => {
	it("sanitizes the resident view at load without publishing over the transcript", async () => {
		const { file, first, second, destination, beforeOpen, afterFirstOpen } = await sharedOpens();
		// The replay signature is on disk and opening did not rewrite it: an append-style patch
		// would leave a second record, so comparing against the pre-open baseline catches it.
		expect(beforeOpen).toContain("signature-to-strip");
		expect(afterFirstOpen).toBe(beforeOpen);
		expect(afterFirstOpen).not.toContain("entry_patch");

		// Loading already stripped the signature in memory, so the public entry point has nothing
		// left to do. That means "no resident entry needed stripping"; the transcript still carries
		// the metadata and every open re-strips it.
		expect(first.sanitizeLoadedOpenAIResponsesReplayMetadata()).toBe(false);
		expect(JSON.stringify(first.getEntries())).not.toContain("signature-to-strip");
		expect(JSON.stringify(second.getEntries())).not.toContain("signature-to-strip");

		// No publication happened, so the bytes are unchanged for everyone and a reopen repeats
		// the same in-memory pass instead of converging the transcript.
		expect(await Bun.file(file).text()).toBe(beforeOpen);
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(JSON.stringify(reopened.getEntries())).not.toContain("signature-to-strip");
		expect(await Bun.file(file).text()).toBe(beforeOpen);
	});
});
