/**
 * Task children must keep the parent plan-mode write boundary.
 * A product-file write is refused. The plan file, and writes with plan mode off, stay allowed.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import type { PlanModeState } from "../src/plan-mode/state";
import type { CreateAgentSessionResult } from "../src/sdk";
import * as sdkModule from "../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../src/session/agent-session";
import { TaskTool } from "../src/task";
import type { TaskParams } from "../src/task/types";
import type { ToolSession } from "../src/tools";
import { WriteTool } from "../src/tools/write";
import { EventBus } from "../src/utils/event-bus";

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	AsyncJobManager.resetForTests();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function writeSession(root: string, getPlanModeState: () => PlanModeState | undefined): ToolSession {
	return {
		cwd: root,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(root, "artifacts"),
		getSessionId: () => "plan-child",
		settings: Settings.isolated({
			"lsp.formatOnWrite": false,
			"lsp.diagnosticsOnWrite": false,
		}),
		getPlanModeState,
	} as unknown as ToolSession;
}

async function writeProductFile(
	root: string,
	getPlanModeState: () => PlanModeState | undefined,
	target: string,
): Promise<void> {
	await new WriteTool(writeSession(root, getPlanModeState)).execute("write-1", {
		path: target,
		content: "mutated\n",
	});
}

function createChildSession(
	root: string,
	target: string,
	onPlanMode: (state: PlanModeState | undefined) => void,
	onWriteError: (error: unknown) => void,
): AgentSession {
	let installed: PlanModeState | undefined;
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		agent: { state: { systemPrompt: ["child"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["write", "yield"],
		setActiveToolsByName: async () => {},
		setConfiguredModelChain: () => {},
		seedDefaultFallbackResolution: () => {},
		setSdkPermissionMode: () => {},
		setClientBridge: () => {},
		setPlanModeState: (next: PlanModeState | undefined) => {
			installed = next;
			onPlanMode(next);
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			try {
				await writeProductFile(root, () => installed, target);
			} catch (error) {
				onWriteError(error);
			}
			state.messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		get messages() {
			return state.messages;
		},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function createParentSession(root: string, planMode: PlanModeState | undefined): ToolSession {
	return {
		cwd: root,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		getSessionFile: () => null,
		getSessionId: () => "parent-session",
		getSessionSpawns: () => "*",
		getPlanModeState: () => planMode,
		modelRegistry: {
			refresh: async () => {},
			getAvailable: () => [],
			getApiKey: async () => null,
		},
	} as unknown as ToolSession;
}

async function delegateWrite(root: string, planMode: PlanModeState | undefined, target: string) {
	let installed: PlanModeState | undefined;
	let writeError: unknown;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
		return {
			session: createChildSession(
				root,
				target,
				state => {
					installed = state;
				},
				error => {
					writeError = error;
				},
			),
			extensionsResult: {} as CreateAgentSessionResult["extensionsResult"],
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	const manager = new AsyncJobManager({ onJobComplete: async () => {} });
	AsyncJobManager.setInstance(manager);
	try {
		const tool = await TaskTool.create(createParentSession(root, planMode));
		const params: TaskParams = {
			agent: "executor",
			tasks: [{ id: "Child", description: "write", assignment: "Update the file." }],
		};
		const result = await tool.execute("tool-call", params);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		if (!result.details?.async?.jobId) throw new Error(`task was not scheduled: ${text}`);
		await manager.waitForAll();
		return { installed, writeError };
	} finally {
		await manager.dispose({ timeoutMs: 100 });
	}
}

describe("task subagent plan-mode write inheritance", () => {
	test("parent plan mode still refuses a product-file write", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-parent-"));
		roots.push(root);
		const product = path.join(root, "src", "app.ts");
		await fs.mkdir(path.dirname(product), { recursive: true });
		await fs.writeFile(product, "original\n");
		const planMode: PlanModeState = { enabled: true, planFilePath: path.join(root, "PLAN.md") };

		await expect(writeProductFile(root, () => planMode, product)).rejects.toThrow(
			/only the plan file may be modified/,
		);
		expect(await fs.readFile(product, "utf8")).toBe("original\n");
	});

	test("a task child refuses a product-file write while the parent is in plan mode", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-child-"));
		roots.push(root);
		const product = path.join(root, "src", "app.ts");
		await fs.mkdir(path.dirname(product), { recursive: true });
		await fs.writeFile(product, "original\n");
		const planMode: PlanModeState = { enabled: true, planFilePath: path.join(root, "PLAN.md"), workflow: "parallel" };

		const { installed, writeError } = await delegateWrite(root, planMode, product);

		expect(installed?.enabled).toBe(true);
		expect(installed?.planFilePath).toBe(planMode.planFilePath);
		expect(writeError).toBeInstanceOf(Error);
		expect((writeError as Error).message).toContain("only the plan file may be modified");
		expect(await fs.readFile(product, "utf8")).toBe("original\n");
	});

	test("a task child still writes a product file when the parent is not in plan mode", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-off-"));
		roots.push(root);
		const product = path.join(root, "src", "app.ts");
		await fs.mkdir(path.dirname(product), { recursive: true });
		await fs.writeFile(product, "original\n");

		const { installed, writeError } = await delegateWrite(root, undefined, product);

		expect(installed).toBeUndefined();
		expect(writeError).toBeUndefined();
		expect(await fs.readFile(product, "utf8")).toBe("mutated\n");
	});

	test("a task child still writes the plan file while the parent is in plan mode", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-file-"));
		roots.push(root);
		const planFile = path.join(root, "PLAN.md");
		const planMode: PlanModeState = { enabled: true, planFilePath: planFile };

		const { writeError } = await delegateWrite(root, planMode, planFile);

		expect(writeError).toBeUndefined();
		expect(await fs.readFile(planFile, "utf8")).toBe("mutated\n");
	});
});
