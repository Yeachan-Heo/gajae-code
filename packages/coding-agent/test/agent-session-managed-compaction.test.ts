import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { getBundledModel, modelSupportsMaintenanceCalls } from "@gajae-code/ai/models";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const stores: AuthStorage[] = [];
const registries: ModelRegistry[] = [];

const user = (content: string, timestamp = 1) => ({ role: "user" as const, content, timestamp });

async function sessionFixture() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-compaction-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	registries.push(registry);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model || !modelSupportsMaintenanceCalls(model)) throw new Error("Expected maintenance-capable bundled model");

	const extensionsDir = path.join(root, "extensions");
	await fs.mkdir(extensionsDir, { recursive: true });
	const extensionPath = path.join(extensionsDir, "compaction.ts");
	await Bun.write(
		extensionPath,
		[
			"export default function(pi) {",
			'\tpi.on("session_before_compact", async (event) => ({',
			'\t\tcompaction: { summary: "shared-hook-summary", shortSummary: undefined,',
			"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
			"\t\t\ttokensBefore: event.preparation.tokensBefore, details: {} },",
			"\t}));",
			"}",
		].join("\n"),
	);
	const loaded = await loadExtensions([extensionPath], cwd);
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, manager, registry);

	// Each completed turn has a genuine assistant record, so preparation can choose a
	// first kept entry and the hook can summarize a nonempty older prefix.
	for (let index = 0; index < 8; index++) {
		manager.appendMessage(user(`older turn ${index} ${"historical context ".repeat(1200)}`, index * 2 + 1));
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `completed turn ${index}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: index * 2 + 2,
		} satisfies AssistantMessage);
	}
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({
			"compaction.enabled": true,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
			"todo.reminders": false,
		}),
		modelRegistry: registry,
		extensionRunner: runner,
	});
	sessions.push(session);
	return { manager, session, file };
}

async function fixture() {
	const base = await sessionFixture();
	// A legacy-route canonical turn after the summarized prefix, which compaction must keep live.
	base.manager.appendMessage(user("root shared canonical turn", 100));
	return base;
}

afterEach(async () => {
	const ownedRoots = roots.splice(0);
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const registry of registries.splice(0)) await registry.dispose();
	for (const store of stores.splice(0)) store.close();
	for (const root of ownedRoots) await fs.rm(root, { recursive: true, force: true });
});

describe("managed session compaction", () => {
	it("runIdleCompaction commits a real context-full summary and rebuilds live context", async () => {
		const { manager, session, file } = await fixture();
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		await session.runIdleCompaction();
		const started = events.filter(event => event.type === "auto_compaction_start");
		expect(started).toEqual([{ type: "auto_compaction_start", reason: "idle", action: "context-full" }]);
		const ended = events.filter(event => event.type === "auto_compaction_end");
		expect(ended).toHaveLength(1);
		const end = ended[0];
		if (end?.type !== "auto_compaction_end") throw new Error("Missing terminal compaction event");
		expect(end).toMatchObject({ action: "context-full", aborted: false });
		expect(end).toMatchObject({ result: { summary: expect.stringContaining("shared-hook-summary") } });
		const committed = manager.getBranch().findLast(entry => entry.type === "compaction");
		expect(committed?.type === "compaction" && committed.summary).toContain("shared-hook-summary");
		expect((await Bun.file(file).text()).includes('"type":"compaction"')).toBe(true);
		expect(
			session.agent.state.messages.some(
				message => message.role === "user" && message.content === "root shared canonical turn",
			),
		).toBe(true);
	});
});

describe("transcript-size emergency floor", () => {
	const answer = () => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 110,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};

	it("still compacts a legacy session above the floor", async () => {
		const { manager, session } = await sessionFixture();
		session.agent.streamFn = answer;
		// Above the 48 MiB transcript floor.
		session.setResourceSampler(() => ({
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: 64 * 1024 * 1024,
		}));
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));

		await session.prompt("next turn");

		const starts = events.filter(event => event.type === "auto_compaction_start");
		expect(starts).toEqual([expect.objectContaining({ reason: "overflow" })]);
		expect(manager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(
			session.agent.state.messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "text" && block.text === "ok"),
			),
		).toBe(true);
	});
});
