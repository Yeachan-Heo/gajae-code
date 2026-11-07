import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

// Sanitizing loaded OpenAI-responses replay metadata rewrites resident entries. On a managed
// destination the persist half is skipped deliberately, so the sanitizer cannot publish over a
// transcript another opener holds - that is the property this case pins, because the opposite
// (sanitation writing through) would be a whole-file replacement nobody fenced.

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
	const first = await SessionManager.open(file, destination);
	const second = await SessionManager.open(file, destination);
	managers.push(first, second);
	return { file, first, second, destination };
}

describe("sanitation on a shared transcript", () => {
	it("sanitizes the resident view at load without publishing over the transcript", async () => {
		const { file, first, second, destination } = await sharedOpens();
		const committed = await Bun.file(file).text();
		// The replay signature is on disk: both openers are reading an unsanitized transcript.
		expect(committed).toContain("signature-to-strip");

		// Loading already sanitized in memory, so the public entry point has nothing left to do.
		// That is the recorded behaviour, not the desired one: it means the signature is stripped
		// for the model without the transcript ever being rewritten.
		expect(first.sanitizeLoadedOpenAIResponsesReplayMetadata()).toBe(false);
		expect(JSON.stringify(first.getEntries())).not.toContain("signature-to-strip");
		expect(JSON.stringify(second.getEntries())).not.toContain("signature-to-strip");

		// No publication happened, so the bytes are unchanged for everyone and a reopen repeats
		// the same in-memory sanitization.
		expect(await Bun.file(file).text()).toBe(committed);
		const reopened = await SessionManager.open(file, destination);
		managers.push(reopened);
		expect(JSON.stringify(reopened.getEntries())).not.toContain("signature-to-strip");
		expect(await Bun.file(file).text()).toBe(committed);
	});
});
