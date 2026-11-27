import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { AsyncJobManager } from "../../src/async";
import type { ModelRegistry } from "../../src/config/model-registry";
import { kNoAuth } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { disposeAllShellSessions } from "../../src/exec/bash-executor";
import * as repositoryBindingModule from "../../src/gjc-runtime/repository-binding";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { TaskTool } from "../../src/task";
import * as discoveryModule from "../../src/task/discovery";
import * as executorModule from "../../src/task/executor";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { checkBashAllowedPrefixes } from "../../src/tools/bash-allowed-prefixes";
import { EventBus } from "../../src/utils/event-bus";
import { stubBashExecutorSettings } from "../helpers/tool-session-settings";

const BINDING = {
	schema: "gjc.repository_binding.v1" as const,
	worktreeRoot: process.cwd(),
	commonDir: null,
	displayPath: process.cwd(),
};

function agent(prefixes?: string[]): AgentDefinition {
	return {
		name: "planner",
		description: "test planner",
		systemPrompt: "test",
		source: "bundled",
		...(prefixes ? { bashAllowedPrefixes: prefixes } : {}),
	};
}

function makeResult(): SingleResult {
	return {
		index: 0,
		id: "InheritRo",
		agent: "planner",
		agentSource: "bundled",
		task: "Inspect.",
		assignment: "Inspect.",
		description: "Inspect",
		exitCode: 0,
		output: "OK",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
	};
}

function createSession(bash: {
	bashAllowedPrefixes?: string[];
	bashRestrictionProfile?: ToolSession["bashRestrictionProfile"];
}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "none",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		modelRegistry: {
			authStorage: undefined,
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => kNoAuth,
		} as unknown as ModelRegistry,
		...bash,
	} as unknown as ToolSession;
}

function installTaskSpies(definition: AgentDefinition): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [definition], projectAgentsDir: null });
	vi.spyOn(repositoryBindingModule, "captureRepositoryBinding").mockResolvedValue(BINDING);
	vi.spyOn(repositoryBindingModule, "resolveTaskRepositoryBinding").mockResolvedValue(BINDING);
	vi.spyOn(repositoryBindingModule, "assertExecutionRootMatchesRepositoryBinding").mockResolvedValue(BINDING);
}

async function spawnOptions(session: ToolSession, definition: AgentDefinition) {
	installTaskSpies(definition);
	const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult());
	const tool = await TaskTool.create(session);
	const jobs = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(jobs);
	const started = await tool.execute("tool-call", {
		agent: "planner",
		tasks: [{ id: "InheritRo", description: "Inspect", assignment: "Inspect the tree." }],
	});
	expect(started.details?.async?.jobId).toBeDefined();
	await jobs.waitForAll();
	await jobs.dispose({ timeoutMs: 100 });
	expect(runSubprocess).toHaveBeenCalledTimes(1);
	return runSubprocess.mock.calls[0]![0];
}

function createMockSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as unknown[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
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
		prompt: async () => {
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
		},
		sendCustomMessage: async () => {},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

async function childBashSurface(options: Parameters<typeof executorModule.runSubprocess>[0]) {
	let captured: CreateAgentSessionOptions | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (sessionOptions?: CreateAgentSessionOptions) => {
		captured = sessionOptions;
		const result: CreateAgentSessionResult = {
			session: createMockSession(),
			extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		};
		return result;
	});
	await executorModule.runSubprocess(options);
	if (!captured) throw new Error("child session was not created");
	return captured;
}

function bashTool(
	surface: { bashAllowedPrefixes?: string[]; bashRestrictionProfile?: ToolSession["bashRestrictionProfile"] },
	cwd: string,
): BashTool {
	const session = {
		cwd,
		getSessionFile: () => null,
		getSessionId: () => "child-bash",
		getCredentialSessionId: () => "child-bash",
		bashAllowedPrefixes: surface.bashAllowedPrefixes,
		bashRestrictionProfile: surface.bashRestrictionProfile,
		settings: {
			has(key: string) {
				return this.get(key) !== undefined;
			},
			get(key: string) {
				if (key === "bashInterceptor.enabled") return false;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bash.stripTrailingHeadTail") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			...stubBashExecutorSettings,
		},
	} as unknown as ToolSession;
	return new BashTool(session);
}

describe("task child bash restriction", () => {
	let cwd = "";

	afterEach(async () => {
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		await disposeAllShellSessions();
		if (cwd) await fs.rm(cwd, { recursive: true, force: true });
		cwd = "";
	});

	it("refuses a command outside the parent read-only allowlist", async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "child-bash-"));
		const definition = agent();
		const forwarded = await spawnOptions(
			createSession({ bashRestrictionProfile: "read-only", bashAllowedPrefixes: ["pwd"] }),
			definition,
		);
		expect(forwarded.bashRestrictionProfile).toBe("read-only");
		expect(forwarded.parentBashAllowedPrefixes).toEqual(["pwd"]);
		vi.restoreAllMocks();

		const surface = await childBashSurface({
			cwd,
			agent: definition,
			task: "Inspect.",
			index: 0,
			id: "InheritRo",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as ModelRegistry,
			enableLsp: false,
			bashRestrictionProfile: forwarded.bashRestrictionProfile,
			parentBashAllowedPrefixes: forwarded.parentBashAllowedPrefixes,
		});
		const tool = bashTool(surface, cwd);
		await expect(tool.execute("attack-id", { command: "id" })).rejects.toThrow(/read-only bash/);
	});

	it("refuses a child allowlist that escapes the parent workflow allowlist", async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "child-bash-"));
		const definition = agent(["cat"]);
		const forwarded = await spawnOptions(
			createSession({ bashRestrictionProfile: "workflow", bashAllowedPrefixes: ["pwd"] }),
			definition,
		);
		expect(forwarded.bashRestrictionProfile).toBe("workflow");
		expect(forwarded.parentBashAllowedPrefixes).toEqual(["pwd"]);
		vi.restoreAllMocks();

		const surface = await childBashSurface({
			cwd,
			agent: definition,
			task: "Inspect.",
			index: 0,
			id: "InheritRo",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as ModelRegistry,
			enableLsp: false,
			bashRestrictionProfile: forwarded.bashRestrictionProfile,
			parentBashAllowedPrefixes: forwarded.parentBashAllowedPrefixes,
		});
		const tool = bashTool(surface, cwd);
		await expectRestrictedRefusal(tool, "attack-cat", "cat secret.txt");
		await expectRestrictedRefusal(tool, "attack-sentinel", "gjc __no_inherited_bash_overlap__");
		await expectRestrictedRefusal(tool, "attack-sentinel-write", "gjc __no_inherited_bash_overlap__ --write");
		await expectRestrictedRefusal(tool, "attack-sentinel-arg", "gjc __no_inherited_bash_overlap__ extra");
		await expectRestrictedRefusal(tool, "attack-quoted", "';'");
	});

	it("refuses a child allowlist disjoint from a parent allowlist with no profile", async () => {
		const definition = agent(["cat"]);
		const forwarded = await spawnOptions(createSession({ bashAllowedPrefixes: ["pwd"] }), definition);
		expect(forwarded.bashRestrictionProfile).toBeUndefined();
		expect(forwarded.parentBashAllowedPrefixes).toEqual(["pwd"]);
		vi.restoreAllMocks();

		const surface = await childBashSurface({
			cwd: process.cwd(),
			agent: definition,
			task: "Inspect.",
			index: 0,
			id: "InheritRo",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as ModelRegistry,
			enableLsp: false,
			bashRestrictionProfile: forwarded.bashRestrictionProfile,
			parentBashAllowedPrefixes: forwarded.parentBashAllowedPrefixes,
		});
		const tool = bashTool(surface, process.cwd());
		await expectRestrictedRefusal(tool, "attack-cat", "cat secret.txt");
		await expectRestrictedRefusal(tool, "attack-sentinel", "gjc __no_inherited_bash_overlap__");
		await expectRestrictedRefusal(tool, "attack-sentinel-write", "gjc __no_inherited_bash_overlap__ --write");
		await expectRestrictedRefusal(tool, "attack-sentinel-arg", "gjc __no_inherited_bash_overlap__ extra");
		await expectRestrictedRefusal(tool, "attack-quoted", "';'");
	});

	it("unrestricted parent still keeps the child bash allowlist", async () => {
		const definition = agent(["pwd"]);
		const forwarded = await spawnOptions(createSession({}), definition);
		expect(forwarded.bashRestrictionProfile).toBeUndefined();
		expect(forwarded.parentBashAllowedPrefixes).toBeUndefined();
		vi.restoreAllMocks();

		const surface = await childBashSurface({
			cwd: process.cwd(),
			agent: definition,
			task: "Inspect.",
			index: 0,
			id: "InheritRo",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as ModelRegistry,
			enableLsp: false,
		});
		expect(surface.bashRestrictionProfile).toBeUndefined();
		expect(surface.bashAllowedPrefixes).toEqual(["pwd"]);
		expect(checkBashAllowedPrefixes("pwd", surface.bashAllowedPrefixes).allowed).toBe(true);
	});

	it("read-only parent with no child allowlist still allows the parent inspection command", async () => {
		const definition = agent();
		const forwarded = await spawnOptions(
			createSession({ bashRestrictionProfile: "read-only", bashAllowedPrefixes: ["pwd"] }),
			definition,
		);
		vi.restoreAllMocks();
		const surface = await childBashSurface({
			cwd: process.cwd(),
			agent: definition,
			task: "Inspect.",
			index: 0,
			id: "InheritRo",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as ModelRegistry,
			enableLsp: false,
			bashRestrictionProfile: forwarded.bashRestrictionProfile,
			parentBashAllowedPrefixes: forwarded.parentBashAllowedPrefixes,
		});
		expect(
			checkBashAllowedPrefixes("pwd", surface.bashAllowedPrefixes, {
				profile: surface.bashRestrictionProfile,
			}).allowed,
		).toBe(true);
	});

	it("overlapping read-only parent still allows the shared inspection command", async () => {
		const definition = agent(["pwd"]);
		const forwarded = await spawnOptions(
			createSession({ bashRestrictionProfile: "read-only", bashAllowedPrefixes: ["pwd", "ls"] }),
			definition,
		);
		vi.restoreAllMocks();
		const surface = await childBashSurface({
			cwd: process.cwd(),
			agent: definition,
			task: "Inspect.",
			index: 0,
			id: "InheritRo",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => kNoAuth,
			} as unknown as ModelRegistry,
			enableLsp: false,
			bashRestrictionProfile: forwarded.bashRestrictionProfile,
			parentBashAllowedPrefixes: forwarded.parentBashAllowedPrefixes,
		});
		expect(
			checkBashAllowedPrefixes("pwd", surface.bashAllowedPrefixes, {
				profile: surface.bashRestrictionProfile,
			}).allowed,
		).toBe(true);
	});

	it("property: child bash prefixes stay inside both allowlists", async () => {
		const loaded = await import("../../src/task/executor");
		const resolve = loaded.resolveChildBashRestriction;
		if (typeof resolve !== "function") {
			throw new Error("child bash restriction resolver is missing");
		}
		const word = fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/);
		const prefix = fc.oneof(
			word,
			fc.tuple(word, word).map(([left, right]) => `${left} ${right}`),
		);
		const list = fc.array(prefix, { maxLength: 4 });
		const profile = fc.constantFrom(undefined, "workflow" as const, "read-only" as const);
		const command = fc.oneof(
			fc.constantFrom(
				"id",
				"pwd",
				"ls",
				"cat secret.txt",
				"git status",
				"gjc __no_inherited_bash_overlap__",
				"gjc __no_inherited_bash_overlap__ --write",
				"gjc __no_inherited_bash_overlap__ extra",
				";",
				"';'",
				"$(id)",
				"true",
			),
			fc.tuple(word, word).map(([left, right]) => `${left} ${right}`),
		);
		await fc.assert(
			fc.property(profile, list, list, command, (parentProfile, parentPrefixes, childPrefixes, sampled) => {
				const result = resolve({ parentProfile, parentPrefixes, childPrefixes });
				const parent = [...new Set(parentPrefixes.map(item => item.trim()).filter(item => item.length > 0))];
				const child = [...new Set(childPrefixes.map(item => item.trim()).filter(item => item.length > 0))];
				if (parentProfile === undefined && parent.length === 0) {
					expect(result.bashRestrictionProfile).toBeUndefined();
					expect(result.bashAllowedPrefixes ?? []).toEqual(child);
				}
				const commands = new Set([
					sampled,
					...parent,
					...child,
					"id",
					"pwd",
					"cat secret.txt",
					"gjc __no_inherited_bash_overlap__",
					"gjc __no_inherited_bash_overlap__ --write",
					"gjc __no_inherited_bash_overlap__ extra",
					";",
					"';'",
				]);
				for (const one of commands) {
					const childAllowed = gateAllowed(one, result.bashAllowedPrefixes, result.bashRestrictionProfile);
					if (!childAllowed) continue;
					const parentAllowed =
						parentProfile === undefined && parent.length === 0 ? true : gateAllowed(one, parent, parentProfile);
					const childDefinitionAllowed = child.length === 0 ? true : gateAllowed(one, child, parentProfile);
					expect(parentAllowed).toBe(true);
					expect(childDefinitionAllowed).toBe(true);
				}
			}),
			{ seed: 20261023, numRuns: 64 },
		);
	});
});

function gateAllowed(
	command: string,
	prefixes: readonly string[] | undefined,
	profile: "workflow" | "read-only" | undefined,
): boolean {
	return checkBashAllowedPrefixes(command, prefixes, profile ? { profile } : {}).allowed;
}

async function expectRestrictedRefusal(tool: BashTool, id: string, command: string): Promise<void> {
	await expect(tool.execute(id, { command })).rejects.toThrow(
		/read-only bash|restricted role-agent bash|shell control operator/,
	);
}
