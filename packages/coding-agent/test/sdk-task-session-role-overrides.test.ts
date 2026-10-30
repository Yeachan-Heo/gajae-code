import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import type { Model } from "@gajae-code/ai/core";
import * as modelResolver from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { resolveEagerTaskDelegation } from "../src/config/task-delegation";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { TaskTool } from "../src/task";
import * as discovery from "../src/task/discovery";
import type { runSubprocess } from "../src/task/executor";
import type { SingleResult } from "../src/task/types";
import type { ToolSession } from "../src/tools";

const roots: string[] = [];
const authStorages: AuthStorage[] = [];
const executor = { name: "executor", description: "executor", systemPrompt: "executor", source: "bundled" as const };
const directive = "Delegate by default for multi-file changes";

function model(provider: "openai" | "anthropic", id: string): Model {
	const result = getBundledModel(provider, id);
	if (!result) throw new Error(`Missing bundled model ${provider}/${id}`);
	return result;
}

async function fixture(settings: Settings, toolNames?: string[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-role-task-"));
	roots.push(root);
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	authStorages.push(authStorage);
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.inMemory(),
		authStorage,
		settings,
		model: model("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
		toolNames,
	});
	const job = session.getToolByName("job") as unknown as { materialize: () => Promise<{ session: ToolSession }> };
	if (!job?.materialize) throw new Error("Expected lazy SDK job tool");
	const adapter = (await job.materialize()).session;
	if (!adapter.modelRegistry) throw new Error("Expected SDK model registry");
	const openai = model("openai", "gpt-4o-mini");
	const anthropic = model("anthropic", "claude-sonnet-4-5");
	vi.spyOn(adapter.modelRegistry, "getAvailable").mockReturnValue([openai, anthropic]);
	return { session, adapter, openai, anthropic };
}

async function captureTool(adapter: ToolSession) {
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [executor], projectAgentsDir: null });
	const captured: Array<{ selector: string | string[] | undefined; profile: string | undefined }> = [];
	const run: typeof runSubprocess = async options => {
		captured.push({ selector: options.modelOverride, profile: options.parentActiveModelProfile });
		return {
			index: options.index,
			id: options.id,
			agent: options.agent.name,
			agentSource: options.agent.source,
			task: options.task,
			assignment: options.assignment,
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 1,
			modelOverride: options.modelOverride,
		} as SingleResult;
	};
	const tool = await TaskTool.create(adapter, { runSubprocess: run });
	return { tool, captured };
}

async function dispatch(tool: TaskTool, adapter: ToolSession, id: string) {
	const result = await tool.execute(id, {
		agent: "executor",
		tasks: [{ id, description: id, assignment: "implement" }],
	});
	expect(result.details?.async?.state).toBe("running");
	const manager = adapter.getAsyncJobManager?.();
	if (!manager) throw new Error("Expected SDK async job manager");
	await manager.waitForAll();
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const auth of authStorages.splice(0)) auth.close();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("SDK task dispatch uses isolated selections and clearing reveals shared settings", async () => {
	const settings = Settings.isolated({ "task.agentModelOverrides": { executor: "openai/inherited" } });
	const first = await fixture(settings, ["job"]);
	const second = await fixture(settings, ["job"]);
	try {
		const a = await captureTool(first.adapter);
		const b = await captureTool(second.adapter);
		await first.session.setSessionAgentModelSelection("executor", first.anthropic);
		await dispatch(a.tool, first.adapter, "first");
		await dispatch(b.tool, second.adapter, "second");
		await first.session.setSessionAgentModelSelection("executor", null);
		await dispatch(a.tool, first.adapter, "cleared");
		expect(a.captured.map(value => value.selector)).toEqual([["anthropic/claude-sonnet-4-5"], ["openai/inherited"]]);
		expect(b.captured.map(value => value.selector)).toEqual([["openai/inherited"]]);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "openai/inherited" });
	} finally {
		await first.session.dispose();
		await second.session.dispose();
	}
});

test("in-flight task snapshots selection and profile ownership before the session changes", async () => {
	const settings = Settings.isolated({
		"task.agentModelOverrides": { executor: ["openai/inherited", "openai/fallback"] },
	});
	const f = await fixture(settings, ["job"]);
	try {
		const profile = {
			name: "test-profile",
			requiredProviders: [],
			modelMapping: { executor: "alias" },
			source: "user" as const,
		};
		Object.assign(f.adapter, { getActiveModelProfile: () => profile.name });
		vi.spyOn(f.adapter.modelRegistry!, "getModelProfile").mockReturnValue(profile);
		const { tool, captured } = await captureTool(f.adapter);
		await f.session.setSessionAgentModelSelection("executor", f.anthropic);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(discovery, "discoverAgents").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { agents: [executor], projectAgentsDir: null };
		});
		const predecessor = dispatch(tool, f.adapter, "predecessor");
		try {
			await entered.promise;
			await f.session.setSessionAgentModelSelection("executor", f.openai);
		} finally {
			release.resolve();
		}
		await predecessor;
		await dispatch(tool, f.adapter, "successor");
		expect(captured).toEqual([
			{ selector: ["anthropic/claude-sonnet-4-5"], profile: undefined },
			{ selector: ["openai/gpt-4o-mini"], profile: undefined },
		]);
		await f.session.setSessionAgentModelSelection("executor", null);
		await dispatch(tool, f.adapter, "inherited");
		expect(captured[2]).toEqual({ selector: ["openai/inherited", "openai/fallback"], profile: undefined });
	} finally {
		await f.session.dispose();
	}
});

test("task capture clones selector arrays returned by a session reader", async () => {
	const f = await fixture(Settings.isolated(), ["job"]);
	try {
		const chain = ["openai/first", "openai/fallback"];
		f.adapter.getAgentModelOverrides = () => ({ executor: chain });
		const { tool, captured } = await captureTool(f.adapter);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(discovery, "discoverAgents").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { agents: [executor], projectAgentsDir: null };
		});
		const pending = dispatch(tool, f.adapter, "array");
		try {
			await entered.promise;
			chain[0] = "openai/changed";
		} finally {
			release.resolve();
		}
		await pending;
		expect(captured[0]?.selector).toEqual(["openai/first", "openai/fallback"]);
	} finally {
		await f.session.dispose();
	}
});

test("authoritative empty map and profile ownership are frozen before registry refresh", async () => {
	const f = await fixture(Settings.isolated(), ["job"]);
	try {
		const profile = {
			name: "refresh",
			requiredProviders: [],
			modelMapping: { executor: ["old/alias"] },
			source: "user" as const,
		};
		Object.assign(f.adapter, { getActiveModelProfile: () => profile.name });
		f.adapter.getAgentModelOverrides = () => ({});
		vi.spyOn(f.adapter.modelRegistry!, "getModelProfile").mockReturnValue(profile);
		const { tool, captured } = await captureTool(f.adapter);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(discovery, "discoverAgents").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { agents: [executor], projectAgentsDir: null };
		});
		const pending = dispatch(tool, f.adapter, "empty");
		try {
			await entered.promise;
			profile.modelMapping.executor[0] = "new/alias";
		} finally {
			release.resolve();
		}
		await pending;
		expect(captured[0]?.selector).toEqual(["openai/gpt-4o-mini"]);
		expect(captured[0]?.profile).toBeUndefined();
	} finally {
		await f.session.dispose();
	}
});

test("profile binding ownership is captured before registry refresh", async () => {
	const f = await fixture(Settings.isolated({ "task.agentModelOverrides": { executor: "old/alias" } }), ["job"]);
	try {
		const profile = {
			name: "refresh",
			requiredProviders: [],
			modelMapping: { executor: ["old/alias"] },
			source: "user" as const,
		};
		Object.assign(f.adapter, { getActiveModelProfile: () => profile.name });
		const profileSpy = vi.spyOn(f.adapter.modelRegistry!, "getModelProfile").mockReturnValue(profile);
		const { tool, captured } = await captureTool(f.adapter);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(discovery, "discoverAgents").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { agents: [executor], projectAgentsDir: null };
		});
		const pending = dispatch(tool, f.adapter, "profile");
		try {
			await entered.promise;
			profileSpy.mockReturnValue({ ...profile, modelMapping: {} });
		} finally {
			release.resolve();
		}
		await pending;
		expect(captured[0]).toEqual({ selector: ["old/alias"], profile: "refresh" });
	} finally {
		await f.session.dispose();
	}
});

test("profile alias authority requires the same normalized ordered effective chain", async () => {
	const settings = Settings.isolated({ "task.agentModelOverrides": { executor: "old/alias" } });
	const f = await fixture(settings, ["job"]);
	try {
		const profile = {
			name: "matching-profile",
			requiredProviders: [],
			modelMapping: { executor: ["old/alias"] },
			source: "user" as const,
		};
		Object.assign(f.adapter, { getActiveModelProfile: () => profile.name });
		vi.spyOn(f.adapter.modelRegistry!, "getModelProfile").mockReturnValue(profile);
		const { tool, captured } = await captureTool(f.adapter);
		await dispatch(tool, f.adapter, "singleton");
		profile.modelMapping.executor = ["old/alias", "old/fallback"];
		settings.override("task.agentModelOverrides", { executor: " old/alias , old/fallback " });
		await dispatch(tool, f.adapter, "ordered");
		settings.override("task.agentModelOverrides", { executor: ["old/fallback", "old/alias"] });
		await dispatch(tool, f.adapter, "reversed");
		settings.override("task.agentModelOverrides", { executor: ["old/alias", "old/other"] });
		await dispatch(tool, f.adapter, "mismatch");
		expect(captured).toEqual([
			{ selector: ["old/alias"], profile: profile.name },
			{ selector: ["old/alias", "old/fallback"], profile: profile.name },
			{ selector: ["old/fallback", "old/alias"], profile: undefined },
			{ selector: ["old/alias", "old/other"], profile: undefined },
		]);
	} finally {
		await f.session.dispose();
	}
});

test("standalone profile fallback freezes its selector chain before registry mutation", async () => {
	const f = await fixture(Settings.isolated(), ["job"]);
	try {
		const profile = {
			name: "fallback",
			requiredProviders: [],
			modelMapping: { executor: ["old/alias", "old/fallback"] },
			source: "user" as const,
		};
		Object.assign(f.adapter, { getActiveModelProfile: () => profile.name });
		f.adapter.getAgentModelOverrides = undefined;
		vi.spyOn(f.adapter.modelRegistry!, "getModelProfile").mockReturnValue(profile);
		const { tool, captured } = await captureTool(f.adapter);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(discovery, "discoverAgents").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { agents: [executor], projectAgentsDir: null };
		});
		const pending = dispatch(tool, f.adapter, "fallback");
		try {
			await entered.promise;
			profile.modelMapping.executor[0] = "new/alias";
		} finally {
			release.resolve();
		}
		await pending;
		expect(captured[0]).toEqual({ selector: ["old/alias", "old/fallback"], profile: "fallback" });
	} finally {
		await f.session.dispose();
	}
});

test("registered SDK task uses the successor session's inherited and selected role maps", async () => {
	const settings = Settings.isolated({ "task.agentModelOverrides": { executor: "openai/inherited" } });
	const f = await fixture(settings, ["job", "task"]);
	try {
		const discover = vi
			.spyOn(discovery, "discoverAgents")
			.mockResolvedValue({ agents: [executor], projectAgentsDir: null });
		const patterns: string[][] = [];
		vi.spyOn(modelResolver, "resolveModelOverrideWithAuthFallback").mockImplementation(async selectors => {
			patterns.push([...selectors]);
			throw new Error("Provider-free test stops before model access");
		});
		const manager = f.adapter.getAsyncJobManager?.();
		if (!manager) throw new Error("Expected SDK async job manager");
		const registered = f.session.getToolByName("task") as unknown as {
			materialize: () => Promise<unknown>;
			execute: TaskTool["execute"];
		};
		if (!registered?.materialize) throw new Error("Expected registered lazy SDK task tool");
		await registered.materialize();
		const start = async (id: string) => {
			const current = f.session.getToolByName("task");
			if (!current) throw new Error("Expected registered SDK task tool");
			const result = await current.execute(id, {
				agent: "executor",
				tasks: [{ id, description: id, assignment: "implement" }],
			});
			expect(result.details?.async?.state).toBe("running");
			const jobId = result.details?.async?.jobId;
			if (!jobId) throw new Error("Expected detached job id");
			return jobId;
		};
		const terminal = async (jobId: string, status: "failed" | "cancelled") => {
			await manager.waitForAll();
			const job = manager.getJob(jobId);
			expect(job?.id).toBe(jobId);
			expect(job?.status).toBe(status);
			expect(job?.endTime).toBeDefined();
			expect((job?.errorText ?? job?.resultText ?? "").length).toBeGreaterThan(0);
			const record = manager.getSubagentRecord(jobId);
			expect(record?.currentJobId).toBe(jobId);
			expect(record?.status).toBe(status);
			return job;
		};
		await f.session.setSessionAgentModelSelection("executor", f.anthropic);
		const originalSessionId = f.session.sessionId;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		discover.mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { agents: [executor], projectAgentsDir: null };
		});
		const predecessor = start("predecessor");
		let predecessorId: string;
		try {
			await entered.promise;
			predecessorId = await predecessor;
			expect(await f.session.newSession()).toBe(false);
			expect(f.session.sessionId).toBe(originalSessionId);
			expect(f.session.getAgentModelOverrides().executor).toBe("anthropic/claude-sonnet-4-5");
			expect(f.session.hasSessionAgentModelOverride("executor")).toBe(true);
		} finally {
			release.resolve();
		}
		await terminal(predecessorId, "cancelled");
		discover.mockResolvedValue({ agents: [executor], projectAgentsDir: null });
		expect(await f.session.newSession()).toBe(true);
		expect(f.session.sessionId).not.toBe(originalSessionId);
		expect(f.session.hasSessionAgentModelOverride("executor")).toBe(false);
		const inherited = await start("inherited");
		const inheritedJob = await terminal(inherited, "failed");
		expect(inheritedJob?.setupFailureSummary).toContain("Provider-free test stops before model access");
		await f.session.setSessionAgentModelSelection("executor", f.openai);
		const selected = await start("selected");
		const selectedJob = await terminal(selected, "failed");
		expect(selectedJob?.setupFailureSummary).toContain("Provider-free test stops before model access");
		expect(patterns).toEqual([["openai/inherited"], ["openai/gpt-4o-mini"]]);
	} finally {
		await f.session.dispose();
	}
	// The real owner shutdown proof waits five seconds for blocked discovery.
}, 15_000);

test("blocked detached work prevents replacement without losing the predecessor selection", async () => {
	const settings = Settings.isolated({ "task.agentModelOverrides": { executor: "openai/inherited" } });
	const f = await fixture(settings, ["job"]);
	try {
		const { tool } = await captureTool(f.adapter);
		await f.session.setSessionAgentModelSelection("executor", f.anthropic);
		const originalSessionId = f.session.sessionId;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(discovery, "discoverAgents").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { agents: [executor], projectAgentsDir: null };
		});
		const predecessor = tool.execute("predecessor", {
			agent: "executor",
			tasks: [{ id: "predecessor", description: "predecessor", assignment: "implement" }],
		});
		try {
			await entered.promise;
			const admission = await predecessor;
			expect(admission.details?.async?.state).toBe("running");
			expect(await f.session.newSession()).toBe(false);
			expect(f.session.sessionId).toBe(originalSessionId);
			expect(f.session.getAgentModelOverrides().executor).toBe("anthropic/claude-sonnet-4-5");
			expect(f.session.hasSessionAgentModelOverride("executor")).toBe(true);
		} finally {
			release.resolve();
		}
		const manager = f.adapter.getAsyncJobManager?.();
		if (!manager) throw new Error("Expected SDK async job manager");
		await manager.waitForAll();
		expect(await f.session.newSession()).toBe(true);
		expect(f.session.sessionId).not.toBe(originalSessionId);
		expect(f.session.hasSessionAgentModelOverride("executor")).toBe(false);
		expect(f.session.getAgentModelOverrides().executor).toBe("openai/inherited");
	} finally {
		await f.session.dispose();
	}
	// The owner shutdown proof waits up to five seconds for physically blocked work.
}, 15_000);

test("session worker provider separation updates eager tool and prompt without changing settings", async () => {
	const settings = Settings.isolated({
		"tools.discoveryMode": "all",
		modelRoles: { default: "openai/gpt-4o-mini" },
		"task.agentModelOverrides": { executor: "openai/gpt-4o-mini" },
	});
	const f = await fixture(settings);
	try {
		expect(f.session.getActiveToolNames()).not.toContain("task");
		expect(f.session.systemPrompt.join("\n")).not.toContain(directive);
		await f.session.setSessionAgentModelSelection("executor", f.anthropic);
		expect(f.session.getActiveToolNames()).toContain("task");
		expect(f.session.systemPrompt.join("\n")).toContain(directive);
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: "openai/gpt-4o-mini" });
		await f.session.setSessionAgentModelSelection("executor", null);
		expect(f.session.systemPrompt.join("\n")).not.toContain(directive);
	} finally {
		await f.session.dispose();
	}
});

test("an authoritative empty session map does not revive stale profile worker bindings", () => {
	const settings = Settings.isolated({ modelRoles: { default: "openai/gpt-4o-mini" } });
	const profile = {
		name: "stale",
		requiredProviders: [],
		modelMapping: { executor: "anthropic/claude-sonnet-4-5" },
		source: "user" as const,
	};
	expect(resolveEagerTaskDelegation({ settings, profile, agentModelOverrides: {} }).eagerTasks).toBe(false);
});
