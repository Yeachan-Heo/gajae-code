import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import {
	createStarReminderBeforeAgentStartContributor,
	type GhResult,
	recordDeclinedAfterNo,
	STAR_REMINDER_CUSTOM_TYPE,
} from "@gajae-code/coding-agent/reminders/star-reminder";
import { AgentSession, type BeforeAgentStartContributor } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

const notFound = (): GhResult => ({ exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
const starred = (): GhResult => ({ exitCode: 0, stdout: "", stderr: "" });

describe("AgentSession before-agent-start contributor seam", () => {
	let tempDir: TempDir;
	let stateDir: string;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-session-star-reminder-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-session-star-state-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
		await fs.rm(stateDir, { recursive: true, force: true });
	});

	function statePath(): string {
		return path.join(stateDir, "star-reminder.json");
	}

	function createSession(contributors: BeforeAgentStartContributor[]) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }, { content: ["Done"] }, { content: ["Done"] }] })
				.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		for (const c of contributors) session.registerBeforeAgentStartContributor(c);
	}

	function reminderMessages(messages: AgentMessage[]): AgentMessage[] {
		return messages.filter(m => m.role === "custom" && m.customType === STAR_REMINDER_CUSTOM_TYPE);
	}

	it("appends a contributor custom message with user attribution for user prompts", async () => {
		const contributor: BeforeAgentStartContributor = async () => ({
			customType: STAR_REMINDER_CUSTOM_TYPE,
			content: "please star",
			display: false,
		});
		createSession([contributor]);

		await session.prompt("hello");

		const injected = reminderMessages(session.messages);
		expect(injected).toHaveLength(1);
		const msg = injected[0];
		if (msg?.role !== "custom") throw new Error("expected custom message");
		expect(msg.attribution).toBe("user");
		expect(msg.display).toBe(false);
	});

	it("is nonfatal when a contributor throws", async () => {
		const contributor: BeforeAgentStartContributor = async () => {
			throw new Error("boom");
		};
		createSession([contributor]);

		await session.prompt("hello");
		// The agent still ran and produced its response.
		expect(session.messages.some(m => m.role === "assistant")).toBe(true);
		expect(reminderMessages(session.messages)).toHaveLength(0);
	});

	it("injects the persuasion message once per logical session (AC6)", async () => {
		await recordDeclinedAfterNo({ statePath: statePath() });
		const runGh = async () => notFound();
		const contributor = createStarReminderBeforeAgentStartContributor(
			{ getSessionId: () => "session-1" },
			{ statePath: statePath(), runGh },
		);
		createSession([contributor]);

		await session.prompt("first");
		await session.prompt("second");

		expect(reminderMessages(session.messages)).toHaveLength(1);
	});

	it("re-injects after a new logical session id (/new)", async () => {
		await recordDeclinedAfterNo({ statePath: statePath() });
		const runGh = async () => notFound();
		let currentId = "session-1";
		const contributor = createStarReminderBeforeAgentStartContributor(
			{ getSessionId: () => currentId },
			{ statePath: statePath(), runGh },
		);
		createSession([contributor]);

		await session.prompt("first");
		currentId = "session-2";
		await session.prompt("after new");

		expect(reminderMessages(session.messages)).toHaveLength(2);
	});

	it("does not inject once the repo is starred (AC7)", async () => {
		await recordDeclinedAfterNo({ statePath: statePath() });
		const runGh = async () => starred();
		const contributor = createStarReminderBeforeAgentStartContributor(
			{ getSessionId: () => "session-1" },
			{ statePath: statePath(), runGh },
		);
		createSession([contributor]);

		await session.prompt("first");

		expect(reminderMessages(session.messages)).toHaveLength(0);
	});
});
