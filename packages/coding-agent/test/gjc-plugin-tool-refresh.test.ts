import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { syncSkillActiveState } from "@gajae-code/coding-agent/skill-state/active-state";
import { TempDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { resolveSubskillActivationForSkillInvocation, toActiveSubskillEntry } from "../src/extensibility/gjc-plugins";

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;
let sessionManager: SessionManager;
let subskillRefreshRebuildGate:
	| {
			toolName: string;
			started: () => void;
			promise: Promise<void>;
	  }
	| undefined;

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise!: () => void;
	const promise = new Promise<void>(resolve => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} fixture`,
		parameters: z.object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: name }] }),
	};
}

async function writeCustomTool(fileName: string, toolName: string): Promise<string> {
	const toolsDir = path.join(tempDir.path(), ".gjc", "gjc-plugins", "refresh-plugin", "tools");
	await fs.mkdir(toolsDir, { recursive: true });
	const toolPath = path.join(toolsDir, fileName);
	await fs.writeFile(
		toolPath,
		`import type { CustomToolFactory } from "@gajae-code/coding-agent/extensibility/custom-tools/types";

const factory: CustomToolFactory = pi => ({
	name: ${JSON.stringify(toolName)},
	label: ${JSON.stringify(toolName)},
	description: "refresh fixture tool",
	parameters: pi.zod.object({}),
	async execute() {
		return { content: [{ type: "text", text: ${JSON.stringify(toolName)} }] };
	},
});

export default factory;
`,
	);
	return toolPath;
}

async function writeSwitchableBehaviorTool(fileName: string, implementationKey: string): Promise<string> {
	const toolsDir = path.join(tempDir.path(), ".gjc", "gjc-plugins", "refresh-plugin", "tools");
	await fs.mkdir(toolsDir, { recursive: true });
	const toolPath = path.join(toolsDir, fileName);
	await fs.writeFile(
		toolPath,
		`import type { CustomToolFactory } from "@gajae-code/coding-agent/extensibility/custom-tools/types";

const factory: CustomToolFactory = pi => {
	const implementation = (globalThis as unknown as Record<string, { description: string; output: string }>)[${JSON.stringify(implementationKey)}]!;
	return {
		name: "domain_note",
		label: "domain_note",
		description: implementation.description,
		parameters: pi.zod.object({}),
		async execute() {
			return { content: [{ type: "text", text: implementation.output }] };
		},
	};
};

export default factory;
`,
	);
	return toolPath;
}

async function activateSubskill(toolPaths: string[], phase = "planner"): Promise<void> {
	const pluginRoot = path.join(tempDir.path(), ".gjc", "gjc-plugins", "refresh-plugin");
	const skillPath = path.join(pluginRoot, "subskills", "design", "SKILL.md");
	await fs.mkdir(path.dirname(skillPath), { recursive: true });
	await fs.writeFile(
		skillPath,
		`---\nname: design\ndescription: refresh fixture\nbinds_to: ralplan\nphase: ${phase}\nactivation_arg: design\ntools:\n  - tools/${path.basename(toolPaths[0]!)}\n---\nRefresh fixture skill.\n`,
	);
	await fs.writeFile(
		path.join(pluginRoot, "gajae-plugin.json"),
		JSON.stringify({
			kind: "gajae-code-plugin",
			name: "refresh-plugin",
			version: "1.0.0",
			subskills: ["subskills/design/SKILL.md"],
			tools: [],
		}),
	);
	const result = await resolveSubskillActivationForSkillInvocation({
		cwd: tempDir.path(),
		skillName: "ralplan",
		args: "--design",
	});
	if (!result.activation) throw new Error("refresh fixture activation missing");
	await syncSkillActiveState({
		cwd: tempDir.path(),
		skill: "ralplan",
		active: true,
		phase,
		sessionId: sessionManager.getSessionId(),
		active_subskills: result.activeSubskillsToPersist.map(toActiveSubskillEntry),
	});
}

beforeEach(async () => {
	tempDir = TempDir.createSync("@gjc-plugin-tool-refresh-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const readTool = makeTool("read");
	const bashTool = makeTool("bash");
	sessionManager = SessionManager.inMemory(tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [readTool, bashTool],
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		toolRegistry: new Map([
			[readTool.name, readTool],
			[bashTool.name, bashTool],
		]),
		rebuildSystemPrompt: async toolNames => {
			const gate = subskillRefreshRebuildGate;
			if (gate && toolNames.includes(gate.toolName)) {
				gate.started();
				await gate.promise;
			}
			return { systemPrompt: ["Test", ...toolNames] };
		},
	});
});

afterEach(async () => {
	subskillRefreshRebuildGate = undefined;
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

describe("AgentSession GJC plugin sub-skill tool refresh", () => {
	test("does not publish tools from a refresh superseded by same-session deactivation", async () => {
		const toolPath = await writeCustomTool("stale-domain-note.ts", "stale_domain_note");
		const started = deferredVoid();
		const release = deferredVoid();
		const gateKey = "__gjcSubskillRefreshGate";
		Object.assign(globalThis, { [gateKey]: { started: started.resolve, promise: release.promise } });
		await fs.writeFile(
			toolPath,
			`import type { CustomToolFactory } from "@gajae-code/coding-agent/extensibility/custom-tools/types";
const gate = (globalThis as unknown as { __gjcSubskillRefreshGate: { started(): void; promise: Promise<void> } }).__gjcSubskillRefreshGate;
gate.started();
await gate.promise;
const factory: CustomToolFactory = pi => ({
	name: "stale_domain_note",
	label: "stale_domain_note",
	description: "stale refresh fixture tool",
	parameters: pi.zod.object({}),
	async execute() { return { content: [{ type: "text", text: "stale" }] }; },
});
export default factory;
`,
		);
		try {
			await activateSubskill([toolPath], "planner");
			const staleRefresh = session.refreshGjcSubskillTools();
			await started.promise;
			await syncSkillActiveState({
				cwd: tempDir.path(),
				skill: "ralplan",
				active: false,
				phase: "planner",
				sessionId: sessionManager.getSessionId(),
				active_subskills: [],
			});
			await session.refreshGjcSubskillTools();
			release.resolve();
			await staleRefresh;

			expect(session.getAllToolNames()).not.toContain("stale_domain_note");
			expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
		} finally {
			delete (globalThis as { __gjcSubskillRefreshGate?: unknown }).__gjcSubskillRefreshGate;
			release.resolve();
		}
	});

	test("refreshes successor sub-skill implementation after an admitted rebuild loses session identity", async () => {
		const implementationKey = "__gjcPluginToolRefreshImplementation";
		const globalImplementations = globalThis as unknown as Record<string, { description: string; output: string }>;
		globalImplementations[implementationKey] = { description: "initial schema", output: "initial" };
		const toolPath = await writeSwitchableBehaviorTool("domain-note.ts", implementationKey);
		await activateSubskill([toolPath]);
		await session.refreshGjcSubskillTools();

		globalImplementations[implementationKey] = { description: "successor schema", output: "stale" };
		const rebuildStarted = deferredVoid();
		const releaseRebuild = deferredVoid();
		subskillRefreshRebuildGate = {
			toolName: "domain_note",
			started: rebuildStarted.resolve,
			promise: releaseRebuild.promise,
		};
		const staleRefresh = session.refreshGjcSubskillTools();
		try {
			await rebuildStarted.promise;
			globalImplementations[implementationKey] = { description: "successor schema", output: "successor" };
			// Only hold the refresh that was admitted against the predecessor identity.
			subskillRefreshRebuildGate = undefined;
			await session.clearContext();
			await session.refreshGjcSubskillTools();
			releaseRebuild.resolve();
			await staleRefresh;

			let output: string | undefined;
			await waitFor(async () => {
				const tool = session.agent.state.tools.find(candidate => candidate.name === "domain_note");
				if (!tool) return false;
				const result = await tool.execute(
					"successor-refresh",
					{},
					undefined,
					undefined as never,
					undefined as never,
				);
				output = result.content.find(block => block.type === "text")?.text;
				return output === "successor";
			}, "successor sub-skill implementation");
			expect(output).toBe("successor");
		} finally {
			delete globalImplementations[implementationKey];
			subskillRefreshRebuildGate = undefined;
			releaseRebuild.resolve();
			await staleRefresh.catch(() => {});
		}
	});

	test("adds, removes, and identically reactivates sub-skill tools", async () => {
		const toolPath = await writeCustomTool("domain-note.ts", "domain_note");
		await activateSubskill([toolPath], "planner");

		await session.refreshGjcSubskillTools();
		expect(session.getAllToolNames()).toContain("domain_note");
		expect(session.getActiveToolNames()).toContain("domain_note");

		await syncSkillActiveState({
			cwd: tempDir.path(),
			skill: "ralplan",
			active: false,
			phase: "critic",
			sessionId: sessionManager.getSessionId(),
			active_subskills: [],
		});

		await session.refreshGjcSubskillTools();
		expect(session.getAllToolNames()).not.toContain("domain_note");
		expect(session.getActiveToolNames()).not.toContain("domain_note");
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);

		await activateSubskill([toolPath], "planner");
		await session.refreshGjcSubskillTools();
		expect(session.getAllToolNames()).toContain("domain_note");
		expect(session.getActiveToolNames()).toContain("domain_note");
	});

	test("rejects sub-skill tools whose names conflict with existing tools", async () => {
		const toolPath = await writeCustomTool("read.ts", "read");
		await activateSubskill([toolPath], "planner");

		await session.refreshGjcSubskillTools();

		expect(session.getAllToolNames().filter(name => name === "read")).toHaveLength(1);
		expect(session.getActiveToolNames()).toEqual(["read", "bash"]);
	});
});
