import { expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import { createAgentSession } from "../src/sdk/session";
import { getSessionClientControls } from "../src/sdk/session-client-controls";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

async function fixture(managed = false, beforeFactory?: (manager: SessionManager) => void) {
	const root = TempDir.createSync("@sdk-control-move-");
	const auth = await AuthStorage.create(":memory:");
	const cwd = path.resolve(root.path());
	const manager = managed
		? SessionManager.create(cwd, SessionManager.managedDestination(cwd, cwd))
		: SessionManager.inMemory(cwd);
	beforeFactory?.(manager);
	const result = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: getBundledModel("openai", "gpt-4o-mini"),
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth, path.join(cwd, "models.yml")),
		agentId: `move-owner-${crypto.randomUUID()}`,
		agentRegistry: new AgentRegistry(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		sessionManager: manager,
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
		session: result.session,
		get jobObservation() {
			return result.jobObservation;
		},
		get mcpManager() {
			return result.mcpManager;
		},
		auth,
		cwd,
		async dispose() {
			await result.session.dispose();
			await result.session.modelRegistry.dispose();
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
	using destination = TempDir.createSync("@sdk-control-move-target-");
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

test("earlier callbacks see retired views and native-rejected reentry cannot poison the committed owner", async () => {
	using first = TempDir.createSync("@sdk-control-early-after-a-");
	using second = TempDir.createSync("@sdk-control-early-after-b-");
	let old: unknown;
	let nestedError: unknown;
	const env = await fixture(false, manager => {
		manager.registerBeforeMoveListener(async () => {
			if (old) await retiredViews(old);
		});
		manager.registerAfterMoveListener(async move => {
			if (move.newCwd !== path.resolve(first.path())) return;
			try {
				await manager.moveTo(second.path());
			} catch (error) {
				nestedError = error;
				throw error;
			}
		});
	});
	try {
		old = getSessionClientControls(env.session);
		await env.session.sessionManager.moveTo(first.path());
		// The pre-existing native coordinator has not run its after cleanup yet.
		// Preserve its reentry rejection; it must not poison the committed SDK owner.
		expect(String(nestedError)).toContain("Coordinator rescope barrier is already active");
		expect(env.session.sessionManager.getCwd()).toBe(path.resolve(first.path()));
		const fresh = getSessionClientControls(env.session);
		expect(fresh).not.toBe(old);
		expect(fresh.retired).toBe(false);
		await retiredViews(old);
	} finally {
		await env.dispose();
	}
});

test("after native cleanup a pre-bound after listener can await a successful committed move chain", async () => {
	const env = await fixture();
	using first = TempDir.createSync("@sdk-control-after-cleanup-a-");
	using second = TempDir.createSync("@sdk-control-after-cleanup-b-");
	const manager = env.session.sessionManager;
	let nestedError: unknown;
	const remove = manager.registerAfterMoveListener(async move => {
		if (move.newCwd !== path.resolve(first.path())) return;
		try {
			await manager.moveTo(second.path());
		} catch (error) {
			nestedError = error;
			throw error;
		}
	});
	try {
		const old = getSessionClientControls(env.session);
		await manager.moveTo(first.path());
		expect(nestedError).toBeUndefined();
		expect(manager.getCwd()).toBe(path.resolve(second.path()));
		expect(getSessionClientControls(env.session).retired).toBe(false);
		await retiredViews(old);
	} finally {
		remove();
		await env.dispose();
	}
});

test("earlier native abort callbacks can retry from an actually restored predecessor", async () => {
	using failed = TempDir.createSync("@sdk-control-early-abort-a-");
	using recovery = TempDir.createSync("@sdk-control-early-abort-b-");
	const env = await fixture(false, manager => {
		manager.registerBeforeMoveListener(move => {
			if (move.newCwd === path.resolve(failed.path())) throw new Error("abort chain fixture");
		});
		manager.registerMoveAbortListener(async move => {
			if (move.newCwd === path.resolve(failed.path())) await manager.moveTo(recovery.path());
		});
	});
	try {
		const old = getSessionClientControls(env.session);
		await expect(env.session.sessionManager.moveTo(failed.path())).rejects.toThrow("abort chain fixture");
		expect(env.session.sessionManager.getCwd()).toBe(path.resolve(recovery.path()));
		expect(getSessionClientControls(env.session).retired).toBe(false);
		await retiredViews(old);
	} finally {
		await env.dispose();
	}
});

test.each([
	"before-factory",
	"after-factory",
] as const)("caught nested-before attempts preserve native outer commit and unchanged owner (%s)", async order => {
	using destination = TempDir.createSync("@sdk-control-before-reentry-");
	using other = TempDir.createSync("@sdk-control-before-reentry-other-");
	const errors: unknown[] = [];
	let attempted = false,
		aborts = 0;
	const install = (manager: SessionManager) => {
		manager.registerMoveAbortListener(() => {
			aborts++;
		});
		manager.registerBeforeMoveListener(async move => {
			if (attempted) return;
			attempted = true;
			await manager.moveTo(manager.getCwd()); // A real current-cwd no-op remains harmless.
			for (const target of [move.newCwd, other.path()]) {
				try {
					await manager.moveTo(target);
				} catch (error) {
					errors.push(error);
				}
			}
		});
	};
	const env = await fixture(false, order === "before-factory" ? install : undefined);
	if (order === "after-factory") install(env.session.sessionManager);
	try {
		const old = getSessionClientControls(env.session);
		await env.session.sessionManager.moveTo(destination.path());
		expect(errors).toHaveLength(2);
		for (const error of errors) expect(String(error)).toContain("cwd move is pending before publication");
		expect(aborts).toBe(0); // Rejected admission never broadcasts abort against the outer move.
		expect(env.session.sessionManager.getCwd()).toBe(path.resolve(destination.path()));
		expect(getSessionClientControls(env.session).retired).toBe(false);
		await retiredViews(old);
	} finally {
		await env.dispose();
	}
});

test.each([
	"new",
	"switch",
] as const)("native %s logical-session cleanup renews views on the same AgentSession", async action => {
	const env = await fixture(action === "switch");
	using targetRoot = TempDir.createSync("@sdk-control-logical-target-");
	const { session } = env,
		manager = session.sessionManager;
	let target: SessionManager | undefined;
	try {
		const old = getSessionClientControls(session),
			oldId = session.sessionId;
		const priorJobs = env.jobObservation;
		if (action === "new") expect(await session.newSession()).toBe(true);
		else {
			const cwd = path.resolve(targetRoot.path());
			target = SessionManager.create(cwd, SessionManager.managedDestination(cwd, env.cwd));
			await env.auth.set("openai", { type: "api_key", key: "switch-fixture-credential" });
			target.appendModelChange("openai/gpt-4o-mini", "default");
			target.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "switch target" }],
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
			await target.flush();
			const file = target.getSessionFile();
			if (!file) throw new Error("Expected real persisted switch target");
			await target.close();
			expect(await session.switchSession(file)).toBe(true);
		}
		expect(session.sessionManager).toBe(manager);
		expect(session.sessionId).not.toBe(oldId);
		const fresh = getSessionClientControls(session);
		expect(fresh).not.toBe(old);
		expect(fresh.retired).toBe(false);
		if (record(old).authorization) expect(record(fresh).authorization).not.toBe(record(old).authorization);
		if (priorJobs) {
			expect(env.jobObservation).not.toBe(priorJobs);
			expect(() => priorJobs.getSnapshot()).toThrow(expect.objectContaining({ code: "disposed" }));
		}
		await retiredViews(old);
		using destination = TempDir.createSync("@sdk-control-logical-move-");
		await manager.moveTo(destination.path());
		const moved = getSessionClientControls(session);
		expect(moved.retired).toBe(false);
		expect(await session.newSession()).toBe(true);
		expect(getSessionClientControls(session)).not.toBe(moved);
		await retiredViews(moved);
	} finally {
		await target?.close();
		await env.dispose();
	}
});

test("observed unauthorized identity poison cannot be laundered by later native logical-session cleanup", async () => {
	const env = await fixture();
	try {
		getSessionClientControls(env.session);
		const mismatch = spyOn(env.session, "getAgentId").mockReturnValue("observed-foreign-owner");
		try {
			unavailable(env.session);
		} finally {
			mismatch.mockRestore();
		}
		expect(await env.session.newSession()).toBe(true);
		unavailable(env.session);
	} finally {
		await env.dispose();
	}
});

test("move binding survives clear without a getter, queued moves, repeated and no-op moves", async () => {
	const env = await fixture();
	using first = TempDir.createSync("@sdk-control-chain-a-");
	using second = TempDir.createSync("@sdk-control-chain-b-");
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
	using destination = TempDir.createSync("@sdk-control-move-abort-");
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
	using destination = TempDir.createSync("@sdk-control-metadata-");
	using recovery = TempDir.createSync("@sdk-control-metadata-recovery-");
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

test("detected immutable owner mismatch during a pending move stays poisoned after restoration", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("@sdk-control-move-owner-");
	const { session } = env,
		manager = session.sessionManager;
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	getSessionClientControls(session);
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

test("move listeners outlive views but unregister at session cleanup", async () => {
	const env = await fixture();
	const manager = env.session.sessionManager;
	getSessionClientControls(env.session);
	const before = spyOn(manager, "registerBeforeMoveListener"),
		after = spyOn(manager, "registerAfterMoveListener"),
		abort = spyOn(manager, "registerMoveAbortListener");
	try {
		getSessionClientControls(env.session);
		await env.session.clearContext();
		getSessionClientControls(env.session);
		// Factory/first getter installed one binding before these spies; no per-view registration.
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
