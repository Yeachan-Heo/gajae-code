/**
 * Regression coverage for #8015: `/resume` inside a root interactive TUI session.
 *
 * A TUI keeps one manager across `/new` and `/resume` (`AgentSession.switchSession` ->
 * `SessionManager.setSessionFile`), so the same manager loads a session it already wrote.
 * Loading a transcript sanitizes stale OpenAI Responses replay metadata. On a managed
 * destination that sanitation is resident-only, so it must not change the transcript,
 * and the resumed session keeps accepting ordinary turns.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const registries: ModelRegistry[] = [];
const settingsStores: Settings[] = [];
const authStores: AuthStorage[] = [];
const provider = "shared-resume-sanitize-fixture";
const selector = `${provider}/model`;
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const staleReplayAssistant = (): AssistantMessage => ({
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "stale reasoning", thinkingSignature: "stale-signature" },
		{ type: "text", text: "stale answer" },
	],
	api: "openai-responses",
	provider: "openai",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
	providerPayload: { type: "openaiResponsesHistory", items: [] },
});

interface Fixture {
	session: AgentSession;
	manager: SessionManager;
	file: string;
	staleId: string;
}

afterEach(async () => {
	vi.restoreAllMocks();
	const failures: unknown[] = [];
	const cleanup: Array<() => unknown> = [
		...sessions.splice(0).map(session => () => session.dispose()),
		...registries.splice(0).map(registry => () => registry.dispose()),
		...managers.splice(0).map(manager => () => manager.closeStrict()),
		...settingsStores.splice(0).map(settings => () => settings.close()),
		...authStores.splice(0).map(auth => () => auth.close()),
		...roots.splice(0).map(root => () => fs.rm(root, { recursive: true, force: true })),
	];
	for (const dispose of cleanup) {
		try {
			await dispose();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "Shared resume sanitize fixture cleanup failed");
});

/** A root TUI session opened the way `gjc --resume` opens it: a fresh strict manager on a managed destination. */
async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-resume-sanitize-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			compaction: { enabled: false },
			todo: { reminders: false },
			startup: { networkPrewarm: false },
			modelRoles: { default: selector },
		}),
	);
	await Bun.write(
		path.join(agentDir, "models.yml"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: "https://shared-resume-sanitize.invalid/v1",
					api: "openai-completions",
					apiKeyEnv: "GJC_TEST_SHARED_RESUME_SANITIZE_API_KEY",
					models: [{ id: "model", input: ["text"], contextWindow: 32_000, maxTokens: 4_000 }],
				},
			},
		}),
	);
	const settings = await Settings.loadForScope({ cwd, agentDir });
	settingsStores.push(settings);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	authStores.push(auth);
	auth.setRuntimeApiKey(provider, "shared-resume-sanitize-test-key");
	const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), settings, {
		agentDir,
		automaticRefresh: false,
	});
	registries.push(registry);
	const model = registry.find(provider, "model");
	if (!model) throw new Error(`Missing fixture model: ${selector}`);
	const destination = SessionManager.managedDestination(cwd, agentDir);

	const writer = SessionManager.create(cwd, destination);
	writer.appendMessage(user("seed question"));
	const staleId = writer.appendMessage(staleReplayAssistant());
	writer.appendModelChange(selector, "default");
	writer.appendThinkingLevelChange(ThinkingLevel.Low);
	await writer.ensureOnDisk();
	await writer.flush();
	const file = writer.getSessionFile();
	if (!file) throw new Error("Missing fixture transcript");
	await writer.closeStrict();
	const seeded = await fs.readFile(file);
	expect(seeded.toString()).toContain("openaiResponsesHistory");

	const inspection = await SessionManager.inspectSessionTailReadOnly(file);
	if (inspection.kind === "error") throw new Error(`Fixture inspection failed: ${inspection.reason}`);
	const opened = await SessionManager.openExistingStrict(inspection.identity, destination);
	if (opened.kind !== "opened") throw new Error(`Fixture strict open failed: ${opened.reason}`);
	const manager = opened.manager;
	managers.push(manager);
	// The fresh strict open sanitizes in memory and leaves the managed transcript alone.
	expectSanitized(manager, staleId);
	expect(await fs.readFile(file)).toEqual(seeded);

	const agent = new Agent({
		initialState: {
			model,
			thinkingLevel: ThinkingLevel.Low,
			systemPrompt: ["Shared resume sanitize fixture"],
			tools: [],
			messages: manager.buildSessionContext().messages,
		},
		streamFn: () => {
			throw new Error("The resume fixture must not request a provider");
		},
	});
	const session = new AgentSession({
		agent,
		agentDir,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		thinkingLevel: ThinkingLevel.Low,
	});
	sessions.push(session);
	await manager.flush();
	return { session, manager, file, staleId };
}

function expectSanitized(manager: SessionManager, staleId: string): void {
	const entry = manager.getEntries().find(candidate => candidate.id === staleId);
	if (entry?.type !== "message" || entry.message.role !== "assistant") throw new Error("missing stale assistant");
	expect(entry.message.providerPayload).toBeUndefined();
	expect(entry.message.content[0]).toMatchObject({ type: "thinking", thinking: "stale reasoning" });
	expect(entry.message.content[0]).not.toHaveProperty("thinkingSignature", "stale-signature");
}

/** An ordinary root TUI turn: the canonical message lands in the transcript. */
async function canonicalMessage(f: Fixture, text: string): Promise<void> {
	f.session.agent.emitExternalEvent({ type: "message_end", message: user(text) });
	await f.session.awaitSessionSettlement();
	await f.manager.flush();
	expect(f.manager.getLeafEntry()).toMatchObject({ type: "message", message: { role: "user", content: text } });
	expect(await Bun.file(f.file).text()).toContain(JSON.stringify(text));
}

describe("#8015 /resume of a root TUI session with stale OpenAI Responses replay metadata", () => {
	it("resumes the predecessor after /new on the same manager without writing to its transcript", async () => {
		const f = await fixture();
		const sessionId = f.session.sessionId;
		await canonicalMessage(f, "first turn");
		const before = await fs.readFile(f.file);
		expect(before.toString()).toContain("openaiResponsesHistory");

		expect(await f.session.newSession()).toBe(true);
		expect(f.session.sessionId).not.toBe(sessionId);
		expect(await f.session.switchSession(f.file)).toBe(true);

		expect(f.session.sessionId).toBe(sessionId);
		expectSanitized(f.manager, f.staleId);
		// The agent context rebuilt by the switch carries the sanitized replay entry.
		const replayed = f.session.agent.state.messages.find(message => message.role === "assistant");
		if (replayed?.role !== "assistant") throw new Error("missing replayed assistant");
		expect(replayed.providerPayload).toBeUndefined();
		expect(await fs.readFile(f.file)).toEqual(before);
		expect((await fs.readFile(f.file)).toString()).not.toContain('"entry_patch"');

		// The resumed session keeps accepting ordinary turns.
		await canonicalMessage(f, "turn after resume");
	});

	it("reloads the current session in place without writing to its transcript", async () => {
		const f = await fixture();
		await canonicalMessage(f, "first turn");
		const before = await fs.readFile(f.file);

		expect(await f.session.switchSession(f.file)).toBe(true);

		expectSanitized(f.manager, f.staleId);
		expect(await fs.readFile(f.file)).toEqual(before);
		await canonicalMessage(f, "turn after reload");
	});
});
