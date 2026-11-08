import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai/models";
import * as z from "zod/v4";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager, SharedSessionMutationUnsupportedError } from "../src/session/session-manager";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const managers: SessionManager[] = [];
const stores: AuthStorage[] = [];
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const manager of managers.splice(0)) await manager.closeStrict();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(durableSettings = false) {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-controls-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const manager = SessionManager.create(cwd, destination);
	managers.push(manager);
	const first = manager.appendMessage(user("first"));
	manager.appendMessage(user("second"));
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const registry = new ModelRegistry(auth);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }] }));
	const tool: AgentTool = {
		name: "control_fixture",
		label: "Control fixture",
		description: "Control admission fixture",
		parameters: z.object({}),
		execute,
	};
	const settings = durableSettings
		? await Settings.loadForScope({ cwd, agentDir })
		: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false });
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] } });
	const rebuild = vi.fn(async () => ({ systemPrompt: ["Rebuilt"] }));
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		toolRegistry: new Map([[tool.name, tool]]),
		rebuildSystemPrompt: rebuild,
	});
	sessions.push(session);
	await manager.flush();
	const admit = async () => {
		const sibling = await SessionManager.open(file, destination);
		managers.push(sibling);
		const peerResult = await sibling.appendMessageSharingSession(user("peer"));
		if (peerResult.kind !== "committed") throw new Error(peerResult.kind);
		const result = await manager.appendMessageSharingSession(user("local"));
		if (result.kind !== "committed") throw new Error(result.kind);
	};
	return {
		session,
		manager,
		agent,
		settings,
		registry,
		model,
		first,
		file,
		admit,
		execute,
		rebuild,
		cwd,
		agentDir,
		destination,
	};
}

async function withinBarrier<T>(pending: Promise<T>, phase: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error(`Timed out waiting for ${phase}`)), 1500);
	try {
		return await Promise.race([pending, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

function observeControl(pending: Promise<void>) {
	return pending.then(
		() => ({ kind: "fulfilled" as const }),
		error => ({ kind: "rejected" as const, error }),
	);
}

function snapshot(session: AgentSession) {
	return structuredClone({
		model: session.model,
		thinking: session.thinkingLevel,
		agentThinking: session.agent.state.thinkingLevel,
		tier: session.serviceTier,
		tools: session.getActiveToolNames(),
		prompt: session.agent.state.systemPrompt,
		messages: session.agent.state.messages,
		profile: session.getActiveModelProfile(),
		selectionRevision: session.getUserModelSelectionRevision(),
		modelRoles: session.settings.get("modelRoles"),
		defaultThinking: session.settings.get("defaultThinkingLevel"),
		manager: {
			revisions: session.sessionManager.revisionSnapshot(),
			entries: session.sessionManager.getEntries(),
			leaf: session.sessionManager.getLeafId(),
		},
	});
}

describe("shared AgentSession control admission", () => {
	it("rejects an already-shared ordinary prompt before preflight refresh", async () => {
		const f = await fixture();
		await f.admit();
		const before = snapshot(f.session);
		const bytes = await Bun.file(f.file).text();
		const sentinel = new Error("ordinary prompt refresh reached");
		const refresh = vi.spyOn(f.session, "refreshGjcSubskillTools").mockRejectedValue(sentinel);
		const credentials = vi.spyOn(f.registry, "getApiKey").mockRejectedValue(new Error("credentials reached"));
		const agentPrompt = vi.spyOn(f.agent, "prompt").mockRejectedValue(new Error("Agent.prompt reached"));
		const accepted = vi.fn();
		const outcome = observeControl(
			f.session.prompt("hello", { expandPromptTemplates: false, onPreflightAcceptCommit: accepted }),
		);
		try {
			const result = await withinBarrier(outcome, "already-shared ordinary prompt refusal");
			expect(result.kind).toBe("rejected");
			if (result.kind === "rejected") expect(result.error).toBeInstanceOf(SharedSessionMutationUnsupportedError);
			expect(refresh).not.toHaveBeenCalled();
			expect(credentials).not.toHaveBeenCalled();
			expect(accepted).not.toHaveBeenCalled();
			expect(agentPrompt).not.toHaveBeenCalled();
			expect(f.execute).not.toHaveBeenCalled();
			expect(snapshot(f.session)).toEqual(before);
			expect(await Bun.file(f.file).text()).toBe(bytes);
		} finally {
			await withinBarrier(outcome, "already-shared ordinary prompt cleanup");
		}
	});

	it("rejects an ordinary prompt admitted to sharing while preflight refresh is suspended", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const refresh = vi.spyOn(f.session, "refreshGjcSubskillTools").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		const credentials = vi.spyOn(f.registry, "getApiKey").mockRejectedValue(new Error("credentials reached"));
		const agentPrompt = vi.spyOn(f.agent, "prompt").mockRejectedValue(new Error("Agent.prompt reached"));
		const accepted = vi.fn();
		const outcome = observeControl(
			f.session.prompt("hello", { expandPromptTemplates: false, onPreflightAcceptCommit: accepted }),
		);
		try {
			await withinBarrier(
				Promise.race([
					entered.promise,
					outcome.then(result => {
						if (result.kind === "rejected") throw result.error;
						throw new Error("Ordinary prompt completed before refresh barrier");
					}),
				]),
				"ordinary prompt refresh barrier",
			);
			await f.admit();
			const before = snapshot(f.session);
			const bytes = await Bun.file(f.file).text();
			release.resolve();
			const result = await withinBarrier(outcome, "ordinary prompt refusal after refresh");
			expect(result.kind).toBe("rejected");
			if (result.kind === "rejected") expect(result.error).toBeInstanceOf(SharedSessionMutationUnsupportedError);
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(credentials).not.toHaveBeenCalled();
			expect(accepted).not.toHaveBeenCalled();
			expect(agentPrompt).not.toHaveBeenCalled();
			expect(f.execute).not.toHaveBeenCalled();
			expect(snapshot(f.session)).toEqual(before);
			expect(await Bun.file(f.file).text()).toBe(bytes);
		} finally {
			release.resolve();
			await withinBarrier(outcome, "suspended ordinary prompt cleanup");
		}
	});

	it("preserves shared local slash command dispatch without ordinary prompt preflight", async () => {
		const f = await fixture();
		const command = vi.fn((_args: string[]) => undefined);
		f.session.setMCPPromptCommands([
			{
				path: "fixture:inspect",
				resolvedPath: "fixture:inspect",
				source: "project",
				command: { name: "inspect", description: "Read-only fixture command", execute: command },
			},
		]);
		await f.admit();
		const before = snapshot(f.session);
		const bytes = await Bun.file(f.file).text();
		const refresh = vi.spyOn(f.session, "refreshGjcSubskillTools").mockRejectedValue(new Error("refresh reached"));
		const credentials = vi.spyOn(f.registry, "getApiKey").mockRejectedValue(new Error("credentials reached"));
		const agentPrompt = vi.spyOn(f.agent, "prompt").mockRejectedValue(new Error("Agent.prompt reached"));
		const accepted = vi.fn();
		const outcome = observeControl(f.session.prompt("/inspect status", { onPreflightAcceptCommit: accepted }));
		try {
			const result = await withinBarrier(outcome, "shared local command dispatch");
			expect(result.kind).toBe("fulfilled");
			expect(command).toHaveBeenCalledTimes(1);
			expect(command.mock.calls[0]?.[0]).toEqual(["status"]);
			expect(refresh).not.toHaveBeenCalled();
			expect(credentials).not.toHaveBeenCalled();
			expect(accepted).not.toHaveBeenCalled();
			expect(agentPrompt).not.toHaveBeenCalled();
			expect(f.execute).not.toHaveBeenCalled();
			expect(snapshot(f.session)).toEqual(before);
			expect(await Bun.file(f.file).text()).toBe(bytes);
		} finally {
			await withinBarrier(outcome, "shared local command cleanup");
		}
	});

	it("keeps nonshared ordinary prompt preflight refresh reachable", async () => {
		const f = await fixture();
		const before = snapshot(f.session);
		const bytes = await Bun.file(f.file).text();
		const sentinel = new Error("ordinary prompt refresh reached");
		const refresh = vi.spyOn(f.session, "refreshGjcSubskillTools").mockRejectedValue(sentinel);
		const credentials = vi.spyOn(f.registry, "getApiKey").mockRejectedValue(new Error("credentials reached"));
		const agentPrompt = vi.spyOn(f.agent, "prompt").mockRejectedValue(new Error("Agent.prompt reached"));
		const accepted = vi.fn();
		const outcome = observeControl(
			f.session.prompt("hello", { expandPromptTemplates: false, onPreflightAcceptCommit: accepted }),
		);
		try {
			const result = await withinBarrier(outcome, "nonshared ordinary prompt refresh sentinel");
			expect(result.kind).toBe("rejected");
			if (result.kind === "rejected") expect(result.error).toBe(sentinel);
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(credentials).not.toHaveBeenCalled();
			expect(accepted).not.toHaveBeenCalled();
			expect(agentPrompt).not.toHaveBeenCalled();
			expect(f.execute).not.toHaveBeenCalled();
			expect(snapshot(f.session)).toEqual(before);
			expect(await Bun.file(f.file).text()).toBe(bytes);
		} finally {
			await withinBarrier(outcome, "nonshared ordinary prompt cleanup");
		}
	});

	it("rejects controls before Agent, settings, UI, credentials, tools, or disk change", async () => {
		const f = await fixture();
		await f.admit();
		const before = snapshot(f.session);
		const bytes = await Bun.file(f.file).text();
		const events = vi.fn();
		const unsubscribe = f.session.subscribe(events);
		const credentials = vi.spyOn(f.registry, "getApiKey");
		const persist = vi.spyOn(f.settings, "commitAtomicBatch");
		const mutationStarted = vi.fn();
		const operations: Array<() => unknown> = [
			() => f.session.setServiceTier("priority"),
			() => f.session.setFastMode(true),
			() => f.session.setThinkingLevel(ThinkingLevel.High, true),
			() => f.session.setThinkingLevelForControl(ThinkingLevel.High, false),
			() => f.session.setThinkingLevelForControl(ThinkingLevel.High, true),
			() => f.session.setModel(f.model, "smol", { onMutationStarted: mutationStarted }),
			() => f.session.setDefaultModelSelection(f.model, ThinkingLevel.High, { onBeforeMutation: mutationStarted }),
			() => f.session.setModelTemporary(f.model),
			() => f.session.setDefaultModelProfileForControl("unavailable", { onBeforeActivation: mutationStarted }),
			() => f.session.setConfiguredModelChain("default", ["anthropic/claude-sonnet-4-5"], "test"),
			() => f.session.setActiveToolsByName([]),
			() => f.session.compact(),
			() => f.session.navigateTree(f.first, { summarize: true }),
		];
		try {
			for (const operation of operations) {
				await expect(Promise.resolve().then(operation)).rejects.toBeInstanceOf(
					SharedSessionMutationUnsupportedError,
				);
				expect(snapshot(f.session)).toEqual(before);
				expect(await Bun.file(f.file).text()).toBe(bytes);
				expect(events).not.toHaveBeenCalled();
				expect(credentials).not.toHaveBeenCalled();
				expect(persist).not.toHaveBeenCalled();
				expect(mutationStarted).not.toHaveBeenCalled();
				expect(f.execute).not.toHaveBeenCalled();
				expect(f.rebuild).not.toHaveBeenCalled();
			}
		} finally {
			unsubscribe();
		}
	});

	it("rechecks admission after model credentials resolve", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string>();
		vi.spyOn(f.registry, "getApiKey").mockImplementation(async () => {
			entered.resolve();
			return release.promise;
		});
		const mutationStarted = vi.fn();
		const pending = f.session.setModel(f.model, "smol", { onMutationStarted: mutationStarted });
		const outcome = observeControl(pending);
		try {
			await withinBarrier(
				Promise.race([
					entered.promise,
					outcome.then(result => {
						if (result.kind === "rejected") throw result.error;
						throw new Error("Model selection settled before credential hook");
					}),
				]),
				"credential hook",
			);
			await withinBarrier(f.admit(), "shared admission during credential hook");
			const before = snapshot(f.session);
			const bytes = await Bun.file(f.file).text();
			release.resolve("test-key");
			const result = await withinBarrier(outcome, "model selection refusal");
			expect(result.kind).toBe("rejected");
			if (result.kind === "rejected") expect(result.error).toBeInstanceOf(SharedSessionMutationUnsupportedError);
			expect(snapshot(f.session)).toEqual(before);
			expect(await Bun.file(f.file).text()).toBe(bytes);
			expect(mutationStarted).not.toHaveBeenCalled();
		} finally {
			release.resolve("test-key");
			await withinBarrier(outcome, "model selection cleanup");
		}
	});

	it("rechecks tool selection after prompt preparation without publishing it", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.rebuild.mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return { systemPrompt: ["Must not publish"] };
		});
		const pending = f.session.setActiveToolsByName([]);
		const outcome = observeControl(pending);
		try {
			await withinBarrier(
				Promise.race([
					entered.promise,
					outcome.then(result => {
						if (result.kind === "rejected") throw result.error;
						throw new Error("Tool selection settled before prompt rebuild hook");
					}),
				]),
				"prompt rebuild hook",
			);
			await withinBarrier(f.admit(), "shared admission during prompt rebuild hook");
			const before = snapshot(f.session);
			release.resolve();
			const result = await withinBarrier(outcome, "tool selection refusal");
			expect(result.kind).toBe("rejected");
			if (result.kind === "rejected") expect(result.error).toBeInstanceOf(SharedSessionMutationUnsupportedError);
			expect(snapshot(f.session)).toEqual(before);
		} finally {
			release.resolve();
			await withinBarrier(outcome, "tool selection cleanup");
		}
	});

	it("retains shared read-only and genuine no-op controls", async () => {
		const f = await fixture();
		await f.admit();
		const before = snapshot(f.session);
		const bytes = await Bun.file(f.file).text();
		f.session.setServiceTier(f.session.serviceTier);
		f.session.setThinkingLevel(f.session.thinkingLevel);
		expect(f.session.getAvailableThinkingLevels().length).toBeGreaterThan(0);
		expect(await f.session.cycleRoleModels([])).toBeUndefined();
		expect(await f.session.activateDiscoveredTools([])).toEqual([]);
		expect(await f.session.navigateTree(f.manager.getLeafId()!, { summarize: true })).toEqual({ cancelled: false });
		expect(snapshot(f.session)).toEqual(before);
		expect(await Bun.file(f.file).text()).toBe(bytes);
	});

	for (const failPublication of [false, true]) {
		it(`refuses durable thinking after sibling shared admission (failure=${failPublication})`, async () => {
			const f = await fixture(true);
			const sibling = await SessionManager.open(f.file, f.destination);
			managers.push(sibling);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const capture = sibling.captureCommittedSnapshot.bind(sibling);
			let paused = false;
			vi.spyOn(sibling, "captureCommittedSnapshot").mockImplementation(async () => {
				if (!paused) {
					paused = true;
					entered.resolve();
					await release.promise;
					if (failPublication) throw new Error("injected shared publication failure");
				}
				return capture();
			});
			const publication = sibling.appendMessageSharingSession(user("sibling first")).then(
				result => ({ kind: "outcome" as const, result }),
				error => ({ kind: "error" as const, error }),
			);
			try {
				await withinBarrier(
					Promise.race([
						entered.promise,
						publication.then(result => {
							if (result.kind === "error") throw result.error;
							throw new Error(`Shared publication settled before snapshot barrier: ${result.result.kind}`);
						}),
					]),
					"sibling shared snapshot barrier",
				);
				const before = snapshot(f.session);
				const bytes = await Bun.file(f.file).text();
				const durableBefore = (await Settings.loadReadonly({ cwd: f.cwd, agentDir: f.agentDir })).get(
					"defaultThinkingLevel",
				);
				const commit = vi.spyOn(f.settings, "commitAtomicBatch");
				const control = await observeControl(f.session.setThinkingLevelForControl(ThinkingLevel.High, true));
				expect(control.kind).toBe("rejected");
				if (control.kind === "rejected")
					expect(control.error).toBeInstanceOf(SharedSessionMutationUnsupportedError);
				expect(commit).not.toHaveBeenCalled();
				expect(snapshot(f.session)).toEqual(before);
				expect(await Bun.file(f.file).text()).toBe(bytes);
				expect(
					(await Settings.loadReadonly({ cwd: f.cwd, agentDir: f.agentDir })).get("defaultThinkingLevel"),
				).toBe(durableBefore);
				release.resolve();
				const result = await withinBarrier(publication, "sibling publication completion");
				if (failPublication) {
					expect(result.kind).toBe("error");
					if (result.kind === "error")
						expect(String(result.error)).toContain("injected shared publication failure");
				} else {
					if (result.kind === "error") throw result.error;
					expect(result.result.kind).toBe("committed");
				}
				// No durable write is needed to prove the short-lived count was released.
				expect(await f.manager.withDurableThinkingControl(async () => "released")).toBe("released");
			} finally {
				release.resolve();
				await withinBarrier(publication, "sibling publication cleanup");
				await f.settings.close();
			}
		});
	}

	for (const fail of [false, true]) {
		it(`holds shared admission through durable thinking commit (failure=${fail})`, async () => {
			const f = await fixture(true);
			const sibling = await SessionManager.open(f.file, f.destination);
			managers.push(sibling);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const commit = f.settings.commitAtomicBatch.bind(f.settings);
			vi.spyOn(f.settings, "commitAtomicBatch").mockImplementation(async patches => {
				entered.resolve();
				await release.promise;
				if (fail) throw new Error("injected settings commit failure");
				return commit(patches);
			});
			const before = snapshot(f.session);
			const bytes = await Bun.file(f.file).text();
			const outcome = observeControl(f.session.setThinkingLevelForControl(ThinkingLevel.High, true));
			try {
				await withinBarrier(
					Promise.race([
						entered.promise,
						outcome.then(result => {
							if (result.kind === "rejected") throw result.error;
							throw new Error("Thinking control completed before settings barrier");
						}),
					]),
					"durable thinking commit barrier",
				);
				for (const manager of [f.manager, sibling]) {
					const revisions = manager.revisionSnapshot();
					const result = await manager.appendMessageSharingSession(user("blocked"));
					expect(result.kind).toBe("rejected");
					if (result.kind === "rejected")
						expect(String(result.error)).toContain("durable_thinking_control_in_flight");
					expect(manager.revisionSnapshot()).toEqual(revisions);
				}
				expect(snapshot(f.session)).toEqual(before);
				expect(await Bun.file(f.file).text()).toBe(bytes);
				const unrelated = SessionManager.create(f.cwd, f.destination);
				managers.push(unrelated);
				const independent = await unrelated.appendMessageSharingSession(user("unrelated session"));
				expect(independent.kind).toBe("committed");
				release.resolve();
				const result = await withinBarrier(outcome, "durable thinking completion");
				if (fail) {
					expect(result.kind).toBe("rejected");
					if (result.kind === "rejected")
						expect(String(result.error)).toContain("Unable to persist reasoning settings");
					expect(snapshot(f.session)).toEqual(before);
				} else {
					if (result.kind === "rejected") throw result.error;
					expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
					expect(f.settings.get("defaultThinkingLevel")).toBe(ThinkingLevel.High);
					expect(
						(await Settings.loadReadonly({ cwd: f.cwd, agentDir: f.agentDir })).get("defaultThinkingLevel"),
					).toBe(ThinkingLevel.High);
					expect(f.manager.getBranch().some(entry => entry.type === "thinking_level_change")).toBe(true);
				}
				await f.manager.flush();
				const later = await f.manager.appendMessageSharingSession(user("after control"));
				expect(later.kind).toBe("committed");
			} finally {
				release.resolve();
				await withinBarrier(outcome, "durable thinking cleanup");
				await f.settings.close();
			}
		});
	}

	it("keeps ordinary control mutations working", async () => {
		const f = await fixture();
		f.session.setServiceTier("priority");
		expect(f.agent.serviceTier).toBe("priority");
		await f.session.setThinkingLevelForControl(ThinkingLevel.High, false);
		expect(f.session.thinkingLevel).toBe(ThinkingLevel.High);
		f.session.setConfiguredModelChain("default", ["anthropic/claude-sonnet-4-5"], "test");
		expect(f.session.getConfiguredModelChain("default")).toEqual(["anthropic/claude-sonnet-4-5"]);
		await f.session.setActiveToolsByName([]);
		expect(f.session.getActiveToolNames()).toEqual([]);
		expect(f.agent.state.systemPrompt).toEqual(["Rebuilt"]);
		expect(f.rebuild).toHaveBeenCalledTimes(1);
		expect(f.execute).not.toHaveBeenCalled();
		await f.manager.flush();
		expect(await Bun.file(f.file).text()).toContain("service_tier_change");
	});
});
