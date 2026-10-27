import { afterEach, describe, expect, it, vi } from "bun:test";
import fc from "fast-check";
import { kNoAuth } from "../../src/config/model-registry";

import { Settings } from "../../src/config/settings";
import type { Skill } from "../../src/extensibility/skills";
import * as skillsModule from "../../src/extensibility/skills";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../../src/session/messages";
import { runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockSession(
	onPrompt: (params: {
		text: string;
		options?: PromptOptions;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
	}) => void,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let promptIndex = 0;
	const state = { messages: [] as unknown[] };

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		setConfiguredModelChain: () => {},
		getConfiguredModelChain: () => undefined,
		seedDefaultFallbackResolution: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			onPrompt({ text, options, promptIndex, emit });
		},
		sendCustomMessage: vi.fn(async () => {}),
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as import("../../src/extensibility/extensions/types").LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("autoloadSkills in executor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-1",
		settings: Settings.isolated(),
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => kNoAuth,
		} as unknown as import("../../src/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	it("calls sendCustomMessage for each autoloaded skill before prompt", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const mockSkills: Skill[] = [
			{
				name: "user-created-skill-a",
				description: "Skill A",
				filePath: "/skills/user-created-skill-a/SKILL.md",
				baseDir: "/skills/user-created-skill-a",
				source: "user",
			},
			{
				name: "user-created-skill-b",
				description: "Skill B",
				filePath: "/skills/user-created-skill-b/SKILL.md",
				baseDir: "/skills/user-created-skill-b",
				source: "user",
			},
		];

		vi.spyOn(skillsModule, "buildSkillPromptMessage").mockImplementation(async skill => ({
			message: `Content of ${skill.name}\n\n---\n\nSkill: ${skill.filePath}`,
			details: {
				name: skill.name,
				path: skill.filePath,
				args: undefined,
				lineCount: 1,
			},
		}));

		await runSubprocess({
			...baseOptions,
			skills: mockSkills,
			autoloadSkills: mockSkills,
		});

		const sendCustomMessage = session.sendCustomMessage as ReturnType<typeof vi.fn>;
		expect(sendCustomMessage).toHaveBeenCalledTimes(2);

		// Verify first skill
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			1,
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: expect.stringContaining("Content of user-created-skill-a"),
				display: false,
				details: { name: "user-created-skill-a", path: "/skills/user-created-skill-a/SKILL.md" },
			},
			{ triggerTurn: false },
		);

		// Verify second skill
		expect(sendCustomMessage).toHaveBeenNthCalledWith(
			2,
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: expect.stringContaining("Content of user-created-skill-b"),
				display: false,
				details: { name: "user-created-skill-b", path: "/skills/user-created-skill-b/SKILL.md" },
			},
			{ triggerTurn: false },
		);
	});

	it("does not call sendCustomMessage when autoloadSkills is empty", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		await runSubprocess(baseOptions);

		const sendCustomMessage = session.sendCustomMessage as ReturnType<typeof vi.fn>;
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});

	it("does not call sendCustomMessage when autoloadSkills is undefined", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		await runSubprocess({ ...baseOptions, autoloadSkills: undefined });

		const sendCustomMessage = session.sendCustomMessage as ReturnType<typeof vi.fn>;
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});

	it("skill messages are sent before the task prompt", async () => {
		const callOrder: string[] = [];
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		// Track sendCustomMessage call order
		(session.sendCustomMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			callOrder.push("sendCustomMessage");
		});

		// Track the original prompt to capture order
		const originalPrompt = session.prompt;
		session.prompt = async (text: string, options?: PromptOptions) => {
			callOrder.push("prompt");
			return originalPrompt(text, options);
		};

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const mockSkill: Skill = {
			name: "user-created-skill",
			description: "A custom skill",
			filePath: "/skills/user-created-skill/SKILL.md",
			baseDir: "/skills/user-created-skill",
			source: "user",
		};

		vi.spyOn(skillsModule, "buildSkillPromptMessage").mockResolvedValue({
			message: "Skill content\n\n---\n\nSkill: /skills/user-created-skill/SKILL.md",
			details: { name: "user-created-skill", path: "/skills/user-created-skill/SKILL.md", lineCount: 1 },
		});

		await runSubprocess({
			...baseOptions,
			skills: [mockSkill],
			autoloadSkills: [mockSkill],
		});

		expect(callOrder).toEqual(["sendCustomMessage", "prompt"]);
	});

	function skillNamed(name: string): Skill {
		return {
			name,
			description: name,
			filePath: `/skills/${name}/SKILL.md`,
			baseDir: `/skills/${name}`,
			source: "user",
		};
	}

	function yieldingSession(): AgentSession {
		return createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
	}

	async function preload(
		agentSource: "project" | "user" | "bundled",
		skills: Skill[],
	): Promise<ReturnType<typeof vi.fn>> {
		const session = yieldingSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		vi.spyOn(skillsModule, "buildSkillPromptMessage").mockImplementation(async skill => ({
			message: `Content of ${skill.name}`,
			details: { name: skill.name, path: skill.filePath, lineCount: 1 },
		}));
		await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, source: agentSource },
			autoloadSkills: skills,
		});
		return session.sendCustomMessage as ReturnType<typeof vi.fn>;
	}

	it("refuses bundled workflow skill preload from a project agent", async () => {
		const send = await preload("project", ["ralplan", "ultragoal", "deep-interview", "autoresearch"].map(skillNamed));
		expect(send).not.toHaveBeenCalled();
	});

	it("refuses a bundled workflow skill while delivering an ordinary skill for a project agent", async () => {
		const send = await preload("project", [skillNamed("ralplan"), skillNamed("user-created-skill-a")]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				details: { name: "user-created-skill-a", path: "/skills/user-created-skill-a/SKILL.md" },
			}),
			{ triggerTurn: false },
		);
	});

	it("allows a user agent to preload a bundled workflow skill", async () => {
		const send = await preload("user", [skillNamed("ralplan")]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({ details: { name: "ralplan" } });
	});

	it("allows a bundled agent to preload a bundled workflow skill", async () => {
		const send = await preload("bundled", [skillNamed("ultragoal")]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({ details: { name: "ultragoal" } });
	});

	it("allows a project agent to preload an ordinary skill", async () => {
		const send = await preload("project", [skillNamed("user-created-skill-a")]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({ details: { name: "user-created-skill-a" } });
	});

	it("property refuses project preload of bundled workflow names", async () => {
		const { projectAgentMayPreloadSkill } = await import("../../src/task/executor");
		expect(typeof projectAgentMayPreloadSkill).toBe("function");
		fc.assert(
			fc.property(
				fc.constantFrom("deep-interview", "ralplan", "ultragoal", "autoresearch"),
				fc.constantFrom("", ".", " ", ". "),
				fc.boolean(),
				(name, suffix, upper) => {
					const skillName = `${upper ? name.toUpperCase() : name}${suffix}`;
					const decision = projectAgentMayPreloadSkill("project", skillName);
					return decision === false && projectAgentMayPreloadSkill("project", skillName) === decision;
				},
			),
			{ seed: 42611, numRuns: 64 },
		);
	});

	it("property accepts ordinary names and non-project sources for workflow preload", async () => {
		const { projectAgentMayPreloadSkill } = await import("../../src/task/executor");
		const { isCanonicalGjcWorkflowSkillFilesystemAlias } = await import("../../src/skill-state/canonical-skills");
		expect(typeof projectAgentMayPreloadSkill).toBe("function");
		fc.assert(
			fc.property(
				fc
					.string({ minLength: 1, maxLength: 32 })
					.filter(name => !isCanonicalGjcWorkflowSkillFilesystemAlias(name)),
				fc.constantFrom("project" as const, "user" as const, "bundled" as const),
				(name, source) => {
					const decision = projectAgentMayPreloadSkill(source, name);
					return decision === true && projectAgentMayPreloadSkill(source, name) === decision;
				},
			),
			{ seed: 42612, numRuns: 64 },
		);
		fc.assert(
			fc.property(
				fc.constantFrom("ralplan", "ultragoal", "deep-interview", "autoresearch"),
				fc.constantFrom("user" as const, "bundled" as const),
				(name, source) => projectAgentMayPreloadSkill(source, name) === true,
			),
			{ seed: 42613, numRuns: 64 },
		);
	});
});
