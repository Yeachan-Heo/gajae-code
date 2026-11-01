import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import type { Api, Model } from "@gajae-code/ai";
import * as ai from "@gajae-code/ai";
import { CommandController } from "../src/modes/controllers/command-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import type { AgentSession } from "../src/session/agent-session";
import type { SessionManager } from "../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

const model = {
	provider: "test-provider",
	id: "test-title-model",
	name: "test-title-model",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	contextWindow: 128_000,
	maxTokens: 4096,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	headers: {},
	compat: {},
} as unknown as Model<Api>;

const DIGEST_EMPTY_DIR = join(tmpdir(), "title-regen-digest-empty");
const STRADDLE_SECRET = "abcdefgh";
const STRADDLE_TEXT = `${"x".repeat(393)}${STRADDLE_SECRET}`;
const STRADDLE_PREFIX = "abcdefg";
const SPACED_SECRET = "abcdefgh ";
const SPACED_TEXT = `${"x".repeat(393)}${SPACED_SECRET}`;
const tempDirs: string[] = [];

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: 0 } as AgentMessage;
}

function createTitleSession(messages: AgentMessage[], secretsEnabled?: boolean): AgentSession {
	const settings = {
		getModelRole(role: string) {
			return role === "default" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
		...(secretsEnabled === undefined
			? {}
			: {
					get(key: string) {
						return key === "secrets.enabled" ? secretsEnabled : undefined;
					},
					getCwd() {
						return DIGEST_EMPTY_DIR;
					},
					getAgentDir() {
						return join(DIGEST_EMPTY_DIR, "agent");
					},
				}),
	};
	return {
		messages,
		model,
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
		},
		settings,
		credentialSessionId: "credential-session",
		agent: { metadataForProvider: () => undefined },
	} as unknown as AgentSession;
}

function titleResponse(title: string): unknown {
	return {
		stopReason: "stop",
		content: [{ type: "toolCall", id: "title-call", name: "set_title", arguments: { title } }],
	};
}

function createManager(): SessionManager & {
	_sessionName: string | undefined;
	_cwd: string;
	moveTo: (cwd: string) => Promise<void>;
	setSessionName: (name: string, source: string) => Promise<boolean>;
} {
	const manager = {
		_sessionName: "Original",
		_cwd: "/tmp/project",
		getCwd() {
			return this._cwd;
		},
		async moveTo(cwd: string) {
			this._cwd = cwd;
		},
		getSessionName() {
			return this._sessionName;
		},
		async setSessionName(name: string) {
			this._sessionName = name;
			return true;
		},
	};
	return manager as unknown as SessionManager & {
		_sessionName: string | undefined;
		_cwd: string;
		moveTo: (cwd: string) => Promise<void>;
		setSessionName: (name: string, source: string) => Promise<boolean>;
	};
}

function createTuiContext(session: AgentSession, sessionManager: SessionManager, showStatus: ReturnType<typeof vi.fn>) {
	const ctx = {
		session,
		sessionManager,
		settings: session.settings,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		showStatus,
	} as unknown as InteractiveModeContext;
	return ctx;
}

afterEach(async () => {
	vi.restoreAllMocks();
	delete process.env.TITLE_TOKEN;
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function outboundTitle(call: { mock: { calls: unknown[][] } }): string {
	const context = call.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
	const content = context?.messages?.[0]?.content;
	if (typeof content !== "string") throw new Error("title request had no user text");
	return content;
}

const SECRET_ENV_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

async function renameOutbound(
	entry: "tui" | "acp",
	secretsEnabled: boolean,
	text: string,
	token = STRADDLE_SECRET,
	movedCwd?: string,
): Promise<string> {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(process.env)) {
		if (!SECRET_ENV_NAME.test(key)) continue;
		saved[key] = process.env[key];
		delete process.env[key];
	}
	process.env.TITLE_TOKEN = token;
	try {
		const completeSimple = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(titleResponse("Generated Title") as never);
		const session = createTitleSession([user(text)], secretsEnabled);
		const manager = createManager();
		if (movedCwd) await manager.moveTo(movedCwd);
		if (entry === "tui") {
			const controller = new CommandController(createTuiContext(session, manager, vi.fn()));
			await controller.handleRenameCommand();
		} else {
			const runtime = {
				session,
				sessionManager: manager,
				settings: session.settings,
				cwd: DIGEST_EMPTY_DIR,
				output: () => {},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			} as unknown as SlashCommandRuntime;
			await executeAcpBuiltinSlashCommand("/rename", runtime);
		}
		return outboundTitle(completeSimple);
	} finally {
		delete process.env.TITLE_TOKEN;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("session title regeneration ordering", () => {
	it("drops a stale TUI regeneration silently after an explicit rename", async () => {
		const completion = Promise.withResolvers<unknown>();
		const completeSimpleCalled = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			completeSimpleCalled.resolve();
			return completion.promise as never;
		});

		const messages = [user("Investigate the original task")];
		const session = createTitleSession(messages);
		const manager = createManager();
		const showStatus = vi.fn();
		const controller = new CommandController(createTuiContext(session, manager, showStatus));

		const staleRegeneration = controller.handleRenameCommand();
		await completeSimpleCalled.promise;
		await controller.handleRenameCommand("Manual");

		completion.resolve(titleResponse("Stale Generated Title"));
		await staleRegeneration;

		expect(manager._sessionName).toBe("Manual");
		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith('Session renamed to "Manual".');
	});

	it("drops a stale ACP regeneration silently after an explicit rename", async () => {
		const completion = Promise.withResolvers<unknown>();
		const completeSimpleCalled = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			completeSimpleCalled.resolve();
			return completion.promise as never;
		});

		const messages = [user("Investigate the original task")];
		const session = createTitleSession(messages);
		const manager = createManager();
		const output: string[] = [];
		const runtime = {
			session,
			sessionManager: manager,
			settings: session.settings,
			cwd: "/tmp/project",
			output: (text: string) => output.push(text),
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;

		const staleRegeneration = executeAcpBuiltinSlashCommand("/rename", runtime);
		await completeSimpleCalled.promise;
		await executeAcpBuiltinSlashCommand("/rename Manual", runtime);

		completion.resolve(titleResponse("Stale Generated Title"));
		expect(await staleRegeneration).toEqual({ consumed: true });

		expect(manager._sessionName).toBe("Manual");
		expect(output).toEqual(["Session renamed to Manual."]);
	});
});

describe("rename digest secret boundary", () => {
	for (const entry of ["tui", "acp"] as const) {
		it(`still sends a straddling secret prefix on ${entry} /rename when obfuscation is off`, async () => {
			const sent = await renameOutbound(entry, false, STRADDLE_TEXT);
			expect(sent.startsWith("<user-message>\n")).toBe(true);
			expect(sent.endsWith("\n</user-message>")).toBe(true);
			expect(sent).toContain(STRADDLE_PREFIX);
			expect(sent).not.toContain(STRADDLE_SECRET);
		});

		it(`obfuscates a secret that crosses the 400-character cut on ${entry} /rename`, async () => {
			const sent = await renameOutbound(entry, true, STRADDLE_TEXT);
			expect(sent.startsWith("<user-message>\n")).toBe(true);
			expect(sent.endsWith("\n</user-message>")).toBe(true);
			expect(sent).not.toContain(STRADDLE_SECRET);
			expect(sent).not.toContain(STRADDLE_PREFIX);
		});

		it(`still sends the trimmed prefix on ${entry} /rename when a spaced secret is not obfuscated`, async () => {
			const sent = await renameOutbound(entry, false, SPACED_TEXT, SPACED_SECRET);
			expect(sent.startsWith("<user-message>\n")).toBe(true);
			expect(sent.endsWith("\n</user-message>")).toBe(true);
			expect(sent).toContain(STRADDLE_PREFIX);
			expect(sent).not.toContain(SPACED_SECRET);
		});

		it(`obfuscates a trailing-space secret that crosses the 400-character cut on ${entry} /rename`, async () => {
			const sent = await renameOutbound(entry, true, SPACED_TEXT, SPACED_SECRET);
			expect(sent.startsWith("<user-message>\n")).toBe(true);
			expect(sent.endsWith("\n</user-message>")).toBe(true);
			expect(sent).not.toContain(STRADDLE_SECRET);
			expect(sent).not.toContain(STRADDLE_PREFIX);
		});

		it(`uses destination project secrets after moving cwd for ${entry} /rename`, async () => {
			const root = await fs.mkdtemp(join(tmpdir(), "title-regen-moved-cwd-"));
			tempDirs.push(root);
			const destinationCwd = join(root, "project-b");
			const destinationSecretsDir = join(destinationCwd, ".gjc");
			const projectSecret = "destination-project-title-secret-7003";
			await fs.mkdir(destinationSecretsDir, { recursive: true });
			await Bun.write(
				join(destinationSecretsDir, "secrets.yml"),
				`- type: plain\n  content: ${JSON.stringify(projectSecret)}\n`,
			);

			const sent = await renameOutbound(
				entry,
				true,
				`${"x".repeat(393)}${projectSecret}`,
				STRADDLE_SECRET,
				destinationCwd,
			);
			expect(sent).not.toContain(projectSecret);
			expect(sent).not.toContain(projectSecret.slice(0, 7));
		});
	}

	it("still sends an ordinary rename digest when secrets are enabled", async () => {
		const text = "Plan the weekly release notes";
		const sent = await renameOutbound("tui", true, text);
		expect(sent).toBe(`<user-message>\n${text}\n</user-message>`);
	});
});
