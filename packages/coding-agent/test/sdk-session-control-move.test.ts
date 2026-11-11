import { expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { BashResult } from "../src/exec/bash-executor";
import { AgentRegistry } from "../src/registry/agent-registry";
import { createAgentSession } from "../src/sdk/session";
import { getSessionClientControls } from "../src/sdk/session-client-controls";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

async function fixture(managed = false) {
	const root = TempDir.createSync("sdk-control-move-");
	const auth = await AuthStorage.create(":memory:");
	const cwd = path.resolve(root.path());
	const result = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: getBundledModel("openai", "gpt-4o-mini"),
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth, path.join(cwd, "models.yml")),
		agentId: `move-owner-${crypto.randomUUID()}`,
		agentRegistry: new AgentRegistry(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		sessionManager: managed
			? SessionManager.create(cwd, SessionManager.managedDestination(cwd, cwd))
			: SessionManager.inMemory(cwd),
		disableExtensionDiscovery: true,
		sdkHostModeSupported: false,
		toolNames: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		deferOptionalModelRefresh: true,
	});
	return {
		...result,
		auth,
		cwd,
		async dispose() {
			await result.session.dispose();
			auth.close();
			root.removeSync();
		},
	};
}
function record(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}
async function retiredViews(value: unknown): Promise<void> {
	const views = record(value);
	const probes: Array<[string, string, unknown[]]> = [
		["preferences", "readRoles", []],
		["operator", "execute", [{ text: "!! printf forbidden" }]],
		["activity", "control", ["activity.snapshot", {}]],
		["composer", "catalog", [{}]],
		["side", "control", ["btw.open", {}]],
		["diff", "scopes", [{}]],
	];
	for (const [name, method, args] of probes) {
		const view = views[name];
		if (!view) continue;
		const invoke = record(view)[method] as (...values: unknown[]) => unknown;
		const result = await Promise.resolve()
			.then(() => invoke.apply(view, args))
			.then(
				() => undefined,
				error => error,
			);
		expect(result).toBeInstanceOf(Error);
	}
}
function unavailable(session: Parameters<typeof getSessionClientControls>[0]): void {
	expect(() => getSessionClientControls(session)).toThrow(expect.objectContaining({ code: "resource_gone" }));
}

test("move retires raw views before publication and waits through all after listeners without poisoning retries", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("sdk-control-move-target-");
	const { session } = env;
	const manager = session.sessionManager;
	const beforeEntered = Promise.withResolvers<void>(),
		releaseBefore = Promise.withResolvers<void>();
	const afterEntered = Promise.withResolvers<void>(),
		releaseAfter = Promise.withResolvers<void>();
	const previous = getSessionClientControls(session);
	const jobs = env.jobObservation,
		mcp = env.mcpManager;
	const authorization = record(previous).authorization;
	const removeBefore = manager.registerBeforeMoveListener(async () => {
		beforeEntered.resolve();
		await releaseBefore.promise;
	});
	const removeAfter = manager.registerAfterMoveListener(async () => {
		afterEntered.resolve();
		await releaseAfter.promise;
	});
	let moving: Promise<void> | undefined;
	try {
		moving = manager.moveTo(destination.path());
		await beforeEntered.promise;
		expect(manager.getCwd()).toBe(env.cwd);
		expect(previous.retired).toBe(true);
		unavailable(session);
		await retiredViews(previous);
		releaseBefore.resolve();
		await afterEntered.promise;
		expect(manager.getCwd()).toBe(path.resolve(destination.path()));
		for (let i = 0; i < 3; i++) unavailable(session);
		releaseAfter.resolve();
		await moving;
		const next = getSessionClientControls(session);
		expect(next).not.toBe(previous);
		expect(record(next).authorization).toBe(authorization);
		expect(env.jobObservation).toBe(jobs);
		expect(env.mcpManager).toBe(mcp);
		await retiredViews(previous);
	} finally {
		releaseBefore.resolve();
		releaseAfter.resolve();
		removeBefore();
		removeAfter();
		await moving;
		await env.dispose();
	}
});

test("move binding survives clear without a getter, queued moves, repeated and no-op moves", async () => {
	const env = await fixture();
	using first = TempDir.createSync("sdk-control-chain-a-");
	using second = TempDir.createSync("sdk-control-chain-b-");
	const { session } = env,
		manager = session.sessionManager;
	try {
		const original = getSessionClientControls(session);
		expect(await session.clearContext()).toBe(true);
		// No fresh facade/getter between clear and either relocation.
		const a = manager.moveTo(first.path()),
			b = manager.moveTo(second.path());
		await Promise.all([a, b]);
		const renewed = getSessionClientControls(session);
		expect(manager.getCwd()).toBe(path.resolve(second.path()));
		expect(renewed).not.toBe(original);
		expect(record(renewed).authorization).toBe(record(original).authorization);
		await manager.moveTo(second.path());
		expect(getSessionClientControls(session)).toBe(renewed);
		await manager.moveTo(first.path());
		expect(getSessionClientControls(session)).not.toBe(renewed);
		await retiredViews(original);
	} finally {
		await env.dispose();
	}
});

test("aborted native before/publication callbacks preserve the predecessor and keep controls renewable", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("sdk-control-move-abort-");
	const { session } = env,
		manager = session.sessionManager;
	try {
		for (const phase of ["before", "publication"] as const) {
			const old = getSessionClientControls(session);
			const remove =
				phase === "before"
					? manager.registerBeforeMoveListener(() => {
							throw new Error("before rejected");
						})
					: manager.registerMovePublicationListener(() => {
							throw new Error("publication rejected");
						});
			try {
				await expect(manager.moveTo(destination.path())).rejects.toThrow(`${phase} rejected`);
			} finally {
				remove();
			}
			expect(manager.getCwd()).toBe(env.cwd);
			const fresh = getSessionClientControls(session);
			expect(fresh).not.toBe(old);
			await retiredViews(old);
		}
		await manager.moveTo(destination.path());
		expect(getSessionClientControls(session).retired).toBe(false);
	} finally {
		await env.dispose();
	}
});

test.each([
	false,
	true,
])("metadata failure uses actual retained destination or restored predecessor, never the cwd counter (managed=%s)", async managed => {
	const env = await fixture(managed);
	using destination = TempDir.createSync("sdk-control-metadata-");
	using recovery = TempDir.createSync("sdk-control-metadata-recovery-");
	const { session } = env,
		manager = session.sessionManager;
	try {
		if (managed) {
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "persisted move" }],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "stop",
				timestamp: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			await manager.flush();
		}
		const old = getSessionClientControls(session),
			oldFile = manager.getSessionFile(),
			generation = manager.getCwdGeneration();
		const actual = manager.assertLegacyMutationAllowed.bind(manager);
		const metadata = spyOn(manager, "assertLegacyMutationAllowed").mockImplementation(operation => {
			if (operation === "append header patch") throw new Error("metadata rejected");
			actual(operation);
		});
		try {
			await expect(manager.moveTo(destination.path())).rejects.toThrow("metadata rejected");
		} finally {
			metadata.mockRestore();
		}
		expect(manager.getCwdGeneration()).toBeGreaterThan(generation);
		expect(manager.getCwd()).toBe(managed ? env.cwd : path.resolve(destination.path()));
		if (managed) expect(manager.getSessionFile()).toBe(oldFile);
		const fresh = getSessionClientControls(session);
		expect(fresh).not.toBe(old);
		expect(fresh.retired).toBe(false);
		await retiredViews(old);
		// A real subsequent move, even back across the old path, remains authorized.
		await manager.moveTo(managed ? recovery.path() : env.cwd);
		expect(getSessionClientControls(session).retired).toBe(false);
	} finally {
		await env.dispose();
	}
});

test.each([
	"cwd",
	"file",
	"managerId",
	"generation",
] as const)("unwitnessed %s change remains poisoned after restoration", async field => {
	const env = await fixture();
	const { session } = env,
		manager = session.sessionManager;
	try {
		getSessionClientControls(session);
		const changed =
			field === "cwd"
				? spyOn(manager, "getCwd").mockReturnValue("/unwitnessed")
				: field === "file"
					? spyOn(manager, "getSessionFile").mockReturnValue("/foreign.jsonl")
					: field === "managerId"
						? spyOn(manager, "getSessionId").mockReturnValue("foreign")
						: spyOn(manager, "getSessionIdentityGeneration").mockReturnValue(
								manager.getSessionIdentityGeneration() + 1,
							);
		try {
			unavailable(session);
		} finally {
			changed.mockRestore();
		}
		unavailable(session);
	} finally {
		await env.dispose();
	}
});

test("preserved authorization flow remains the exact owner across move before facade recreation", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("sdk-control-auth-move-");
	const { session } = env;
	type AuthView = { execute(operation: string, input: Record<string, unknown>): Promise<unknown> };
	const first = getSessionClientControls(session),
		authorization = record(first).authorization as AuthView | undefined;
	try {
		// Auth-only has no cwd cache; standalone family copies do not install auth.
		if (!authorization) return;
		const answered = Promise.withResolvers<string>();
		const login = spyOn(env.auth, "login").mockImplementation(async (_provider, callbacks) => {
			answered.resolve(await callbacks.onPrompt({ message: "Move-bound code" }));
		});
		try {
			const flow = record(await authorization.execute("auth.start", { provider: "minimax-code" }));
			let waiting = flow;
			for (let i = 0; i < 100 && !waiting.prompt; i++) {
				await Bun.sleep(1);
				waiting = record(await authorization.execute("auth.read", { flowId: flow.id }));
			}
			expect(waiting.prompt).toBeDefined();
			await session.sessionManager.moveTo(destination.path());
			const next = getSessionClientControls(session);
			expect(record(next).authorization).toBe(authorization);
			await authorization.execute("auth.answer", {
				flowId: flow.id,
				promptId: record(waiting.prompt).id,
				value: "retained-answer",
			});
			expect(await answered.promise).toBe("retained-answer");
			expect(login).toHaveBeenCalledTimes(1);
		} finally {
			login.mockRestore();
		}
	} finally {
		await env.dispose();
	}
});

test("detected immutable owner mismatch during a pending move stays poisoned after restoration", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("sdk-control-move-owner-");
	const { session } = env,
		manager = session.sessionManager;
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const remove = manager.registerBeforeMoveListener(async () => {
		entered.resolve();
		await release.promise;
	});
	let moving: Promise<void> | undefined;
	try {
		getSessionClientControls(session);
		moving = manager.moveTo(destination.path());
		await entered.promise;
		const identity = spyOn(session, "getAgentId").mockReturnValue("foreign-move-owner");
		try {
			unavailable(session);
		} finally {
			identity.mockRestore();
		}
		release.resolve();
		await moving;
		unavailable(session);
		unavailable(session);
	} finally {
		release.resolve();
		remove();
		await moving;
		await env.dispose();
	}
});

test("retiring moved operator views cannot release an unsettled native execution or revive its opaque ID", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("sdk-control-move-execution-");
	type Operator = { execute(input: unknown): { operation: { operationId: string } }; read(input: unknown): unknown };
	const old = record(getSessionClientControls(env.session)).operator as Operator | undefined;
	const pending = Promise.withResolvers<BashResult>();
	const execute = spyOn(env.session, "executeBash").mockImplementation(() => pending.promise);
	try {
		if (!old) return;
		const accepted = old.execute({ text: "!! held" });
		await env.session.sessionManager.moveTo(destination.path());
		const next = record(getSessionClientControls(env.session)).operator as Operator;
		expect(() => old.read({ operationId: accepted.operation.operationId })).toThrow();
		expect(() => next.execute({ text: "!! overlapping" })).toThrow(expect.objectContaining({ code: "busy" }));
		pending.resolve({
			output: "settled",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 7,
			outputLines: 1,
			outputBytes: 7,
		});
		for (let i = 0; i < 50; i++) await Promise.resolve();
		expect(() => next.read({ operationId: accepted.operation.operationId })).toThrow(
			expect.objectContaining({ code: "not_found" }),
		);
		expect(next.execute({ text: "!! fresh" }).operation.operationId).not.toBe(accepted.operation.operationId);
	} finally {
		pending.resolve({
			output: "settled",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 7,
			outputLines: 1,
			outputBytes: 7,
		});
		execute.mockRestore();
		await env.dispose();
	}
});

test("move listeners outlive views but unregister at session cleanup", async () => {
	const env = await fixture();
	const manager = env.session.sessionManager;
	const before = spyOn(manager, "registerBeforeMoveListener"),
		after = spyOn(manager, "registerAfterMoveListener"),
		abort = spyOn(manager, "registerMoveAbortListener");
	try {
		getSessionClientControls(env.session);
		await env.session.clearContext();
		getSessionClientControls(env.session);
		// Factory already installed the one binding before these spies; no per-view registration.
		expect(before).not.toHaveBeenCalled();
		expect(after).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		await env.session.dispose();
		unavailable(env.session);
	} finally {
		before.mockRestore();
		after.mockRestore();
		abort.mockRestore();
		await env.dispose();
	}
});
