import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, UserMessage } from "@gajae-code/ai";
import { exportSessionToHtml } from "@gajae-code/coding-agent/export/html";
import { SessionManager, type SessionMessageEntry } from "@gajae-code/coding-agent/session/session-manager";

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function tempRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resident-own-"));
	tempDirs.push(dir);
	return dir;
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function textOf(entry: SessionMessageEntry): string {
	const message = entry.message;
	if (
		message.role !== "assistant" &&
		message.role !== "user" &&
		message.role !== "developer" &&
		message.role !== "toolResult"
	) {
		throw new Error("Expected text-bearing message");
	}
	const content = message.content;
	if (typeof content === "string") return content;
	return content.find(part => part.type === "text")?.text ?? "";
}

function messages(sm: SessionManager): SessionMessageEntry[] {
	return sm.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message");
}

async function createSession(): Promise<{ sm: SessionManager; root: string }> {
	const root = tempRoot();
	const sm = SessionManager.create(root, path.join(root, "sessions"));
	sm.appendMessage({ role: "user", content: "first user", timestamp: Date.now() });
	sm.appendMessage(assistant(`first assistant ${"a".repeat(2048)}`));
	await sm.ensureOnDisk();
	await sm.flush();
	return { sm, root };
}

describe("resident cache public ownership and revision invalidation", () => {
	it("protects canonical state from mutation of getEntries results", async () => {
		const { sm } = await createSession();
		const originalEntries = sm.getEntries();
		const originalLength = originalEntries.length;
		const first = originalEntries[0] as SessionMessageEntry;
		originalEntries.push({ ...first, id: "fake-entry", timestamp: new Date().toISOString() });
		originalEntries.splice(0, 1);
		first.id = "mutated-id";
		first.message.role = "assistant" as never;
		if (first.message.role !== "user" && first.message.role !== "assistant")
			throw new Error("Expected mutable message");
		first.message.content = [{ type: "text", text: "mutated nested content" }] as never;

		const fresh = sm.getEntries();
		expect(fresh).toHaveLength(originalLength);
		expect(fresh.map(e => e.id)).not.toContain("fake-entry");
		expect(fresh.map(e => e.id)).not.toContain("mutated-id");
		expect(JSON.stringify(fresh)).not.toContain("mutated nested content");
		expect(JSON.stringify(sm.getEntry(fresh[0]!.id))).not.toContain("mutated nested content");
		expect(JSON.stringify(sm.buildSessionContext())).not.toContain("mutated nested content");

		const liveHtml = path.join(tempRoot(), "live.html");
		await exportSessionToHtml(sm, undefined, { outputPath: liveHtml });
		expect(await Bun.file(liveHtml).text()).not.toContain("mutated nested content");
		await sm.close();
	});

	it("protects canonical state from mutation of buildSessionContext nested message results", async () => {
		const { sm } = await createSession();
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "payload owner" }],
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: "openai",
				items: [{ content: [{ text: "canonical provider payload" }] }],
			},
			timestamp: Date.now() + 20,
		});
		const context = sm.buildSessionContext();
		const user = context.messages.find(
			(message): message is UserMessage => message.role === "user" && Array.isArray(message.content),
		);
		if (!user || !Array.isArray(user.content)) throw new Error("Expected array user content");
		user.content[0] = { type: "text", text: "mutated context content" } as never;
		const payload = user.providerPayload as unknown as { items: Array<{ content: Array<{ text: string }> }> };
		payload.items[0]!.content[0]!.text = "mutated provider payload";

		expect(JSON.stringify(sm.buildSessionContext())).toContain("canonical provider payload");
		expect(JSON.stringify(sm.buildSessionContext())).not.toContain("mutated context content");
		expect(JSON.stringify(sm.buildSessionContext())).not.toContain("mutated provider payload");
		expect(JSON.stringify(sm.getEntries())).not.toContain("mutated context content");
		expect(JSON.stringify(sm.getEntries())).not.toContain("mutated provider payload");

		const liveHtml = path.join(tempRoot(), "context-owner.html");
		await exportSessionToHtml(sm, undefined, { outputPath: liveHtml });
		const html = await Bun.file(liveHtml).text();
		expect(html).not.toContain("mutated context content");
		expect(html).not.toContain("mutated provider payload");
		await sm.close();
	});

	it("invalidates materialized reads after append, prune updates, branch moves, and header title changes", async () => {
		const { sm } = await createSession();
		const before = sm.getEntries();
		const appendedId = sm.appendMessage({ role: "user", content: "second user", timestamp: Date.now() + 1 });
		const afterAppend = sm.getEntries();
		expect(afterAppend).toHaveLength(before.length + 1);
		expect(afterAppend.at(-1)?.id).toBe(appendedId);
		expect(afterAppend.slice(0, -1)).toEqual(before);

		const assistantEntry = messages(sm).find(entry => entry.message.role === "assistant");
		if (!assistantEntry) throw new Error("Expected assistant entry");
		const updated: SessionMessageEntry = structuredClone(assistantEntry);
		if (updated.message.role !== "assistant") throw new Error("Expected assistant entry");
		updated.message.content = [{ type: "text", text: "pruned replacement visible" }];
		sm.applyEntryMessageUpdates([updated]);
		expect(textOf(sm.getEntry(assistantEntry.id) as SessionMessageEntry)).toBe("pruned replacement visible");
		expect(JSON.stringify(sm.buildSessionContext())).toContain("pruned replacement visible");

		sm.branch(assistantEntry.id);
		sm.appendMessage({ role: "user", content: "branched user", timestamp: Date.now() + 2 });
		expect(JSON.stringify(sm.buildSessionContext().messages)).toContain("branched user");
		expect(JSON.stringify(sm.getEntries())).toContain("second user");

		await sm.setSessionName("Resident Cache Title", "user");
		const liveHtml = path.join(tempRoot(), "title.html");
		await exportSessionToHtml(sm, undefined, { outputPath: liveHtml });
		const html = await Bun.file(liveHtml).text();
		const exportedJson = Buffer.from(
			html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1] ?? "",
			"base64",
		).toString();
		expect(exportedJson).toContain("Resident Cache Title");
		await sm.close();
	});

	it("returns stable equal-by-value snapshots until append and then differs by exactly the appended entry", async () => {
		const { sm } = await createSession();
		const first = sm.getEntries();
		const second = sm.getEntries();
		expect(second).toEqual(first);

		const appendedId = sm.appendMessage({
			role: "user",
			content: "cache invalidation append",
			timestamp: Date.now() + 10,
		});
		const afterAppend = sm.getEntries();
		expect(afterAppend.slice(0, first.length)).toEqual(first);
		const appended = sm.getEntry(appendedId);
		if (!appended) throw new Error("Expected appended entry");
		expect(afterAppend.slice(first.length)).toEqual([appended]);
		await sm.close();
	});
});
