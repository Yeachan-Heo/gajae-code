import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
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

async function fixture(managed: boolean | "explicit" = false, beforeFactory?: (manager: SessionManager) => void) {
	const root = TempDir.createSync("@sdk-control-move-");
	const auth = await AuthStorage.create(":memory:");
	const cwd = path.resolve(root.path());
	const manager =
		managed === "explicit"
			? SessionManager.create(cwd, SessionManager.explicitDestination(path.join(cwd, "sessions")))
			: managed
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

test("first SDK lookup in publication after logical renewal cannot poison the committed owner", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("@sdk-late-lifetime-publication-");
	const { session } = env;
	const manager = session.sessionManager;
	getSessionClientControls(session);
	let lookupError: unknown;
	let admitted = false;
	let remove = () => {};
	try {
		expect(await session.newSession()).toBe(true);
		// No facade lookup rebinds the lifetime between logical renewal and move.
		remove = manager.registerMovePublicationListener(() => {
			try {
				getSessionClientControls(session);
				admitted = true;
			} catch (error) {
				lookupError = error;
			}
		});
		await manager.moveTo(destination.path());
		expect(manager.getCwd()).toBe(path.resolve(destination.path()));
		expect(getSessionClientControls(session).retired).toBe(false);
		expect(admitted).toBe(false);
		expect(lookupError).toBeInstanceOf(Error);
		expect(record(lookupError).code).toBe("resource_gone");
	} finally {
		remove();
		await env.dispose();
	}
});

test.each([
	["new", "before"],
	["new", "publication"],
	["new", "after"],
	["new", "abort"],
	["switch", "before"],
	["switch", "publication"],
	["switch", "after"],
	["switch", "abort"],
] as const)("first SDK lookup after native %s waits through %s and writer settlement", async (action, phase) => {
	const env = await fixture(action === "switch");
	using destination = TempDir.createSync("@sdk-late-binding-destination-");
	using switchRoot = TempDir.createSync("@sdk-late-binding-switch-");
	const { session } = env,
		manager = session.sessionManager;
	const old = getSessionClientControls(session);
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let target: SessionManager | undefined, moving: Promise<unknown> | undefined;
	let lookupError: unknown,
		admitted = false;
	const removes: Array<() => void> = [];
	try {
		if (action === "new") expect(await session.newSession()).toBe(true);
		else {
			const cwd = path.resolve(switchRoot.path());
			target = SessionManager.create(cwd, SessionManager.managedDestination(cwd, env.cwd));
			await env.auth.set("openai", { type: "api_key", key: "late-binding-switch-credential" });
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
			if (!file) throw new Error("Expected persisted native switch target");
			await target.close();
			expect(await session.switchSession(file)).toBe(true);
		}
		// Do not obtain fresh controls before the first callback lookup.
		const listener = async () => {
			try {
				getSessionClientControls(session);
				admitted = true;
			} catch (error) {
				lookupError = error;
			}
			entered.resolve();
			await release.promise;
		};
		if (phase === "before") removes.push(manager.registerBeforeMoveListener(listener));
		else if (phase === "publication") removes.push(manager.registerMovePublicationListener(listener));
		else if (phase === "after") removes.push(manager.registerAfterMoveListener(listener));
		else {
			removes.push(
				manager.registerMovePublicationListener(() => {
					throw new Error("late binding abort fixture");
				}),
			);
			removes.push(manager.registerMoveAbortListener(listener));
		}
		moving = manager.moveTo(destination.path()).then(
			() => undefined,
			error => error,
		);
		await entered.promise;
		expect(manager.hasPendingCwdMove()).toBe(true);
		expect(admitted).toBe(false);
		expect(record(lookupError).code).toBe("resource_gone");
		for (let i = 0; i < 3; i++) unavailable(session);
		release.resolve();
		const result = await moving;
		if (phase === "abort") expect(String(result)).toContain("late binding abort fixture");
		else expect(result).toBeUndefined();
		expect(manager.hasPendingCwdMove()).toBe(false);
		const fresh = getSessionClientControls(session);
		expect(fresh.retired).toBe(false);
		expect(fresh).not.toBe(old);
		await retiredViews(old);
		for (const remove of removes.splice(0)) remove();
		// The settled replacement observes the next native move normally.
		await manager.moveTo(phase === "abort" ? destination.path() : env.cwd);
		expect(getSessionClientControls(session).retired).toBe(false);
	} finally {
		release.resolve();
		await moving;
		for (const remove of removes) remove();
		await target?.close();
		await env.dispose();
	}
});

test("late lifetime capture rejects a queued native admission before any move callback", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("@sdk-late-binding-queued-");
	const { session } = env,
		manager = session.sessionManager;
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let writer: Promise<void> | undefined, moving: Promise<void> | undefined;
	try {
		getSessionClientControls(session);
		expect(await session.newSession()).toBe(true);
		writer = manager.runExclusiveCwdTransition(async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		moving = manager.moveTo(destination.path());
		expect(manager.hasPendingCwdMove()).toBe(true);
		unavailable(session);
		release.resolve();
		await writer;
		await moving;
		expect(manager.hasPendingCwdMove()).toBe(false);
		expect(getSessionClientControls(session).retired).toBe(false);
	} finally {
		release.resolve();
		await writer;
		await moving;
		await env.dispose();
	}
});

test("late lifetime capture waits for actual owned move work without a move-admission wrapper", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("@sdk-late-binding-owned-work-");
	const { session } = env,
		manager = session.sessionManager;
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let child: Promise<void> | undefined, writer: Promise<void> | undefined;
	const remove = manager.registerAfterMoveListener(async () => {
		entered.resolve();
		await release.promise;
	});
	try {
		getSessionClientControls(session);
		expect(await session.newSession()).toBe(true);
		writer = manager.runExclusiveCwdTransition(async () => {
			child = manager.moveTo(destination.path());
			await entered.promise;
		});
		await entered.promise;
		expect(manager.hasPendingCwdMove()).toBe(true);
		unavailable(session);
		release.resolve();
		await child;
		await writer;
		expect(manager.hasPendingCwdMove()).toBe(false);
		expect(getSessionClientControls(session).retired).toBe(false);
	} finally {
		release.resolve();
		await child;
		await writer;
		remove();
		await env.dispose();
	}
});

test("caught publication reentry does not poison the outer committed owner", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("@sdk-publication-outer-");
	using nested = TempDir.createSync("@sdk-publication-nested-");
	const manager = env.session.sessionManager;
	const previous = getSessionClientControls(env.session);
	const authorization = record(previous).authorization;
	let attempted = false;
	let nestedError: unknown;
	const remove = manager.registerMovePublicationListener(async () => {
		if (attempted) return;
		attempted = true;
		try {
			await manager.moveTo(nested.path());
		} catch (error) {
			nestedError = error;
		}
	});
	try {
		await manager.moveTo(destination.path());
		expect(manager.getCwd()).toBe(path.resolve(destination.path()));
		expect(nestedError).toBeInstanceOf(Error);
		const renewed = getSessionClientControls(env.session);
		expect(renewed.retired).toBe(false);
		expect(record(renewed).authorization).toBe(authorization);
		await retiredViews(previous);
	} finally {
		remove();
		await env.dispose();
	}
});

test.each([
	"before-factory",
	"after-factory",
] as const)("caught publication reentry retains outer admission, views and active authorization (%s)", async order => {
	using destination = TempDir.createSync("@sdk-publication-order-outer-");
	using nested = TempDir.createSync("@sdk-publication-order-nested-");
	const errors: unknown[] = [];
	let attempted = false,
		aborts = 0,
		beforeCalls = 0;
	const install = (manager: SessionManager) => {
		manager.registerBeforeMoveListener(() => {
			beforeCalls++;
		});
		manager.registerMoveAbortListener(() => {
			aborts++;
		});
		manager.registerMovePublicationListener(async move => {
			if (attempted) return;
			attempted = true;
			await manager.moveTo(manager.getCwd()); // Current-cwd no-op is still allowed.
			for (const target of [move.newCwd, nested.path()]) {
				try {
					await manager.moveTo(target);
				} catch (error) {
					errors.push(error);
				}
			}
		});
	};
	const env = await fixture(false, order === "before-factory" ? install : undefined);
	const { session } = env,
		manager = session.sessionManager;
	if (order === "after-factory") install(manager);
	type AuthView = { execute(operation: string, input: Record<string, unknown>): Promise<unknown> };
	const old = getSessionClientControls(session),
		authorization = record(old).authorization as AuthView | undefined;
	const answered = Promise.withResolvers<string>();
	const login = spyOn(env.auth, "login").mockImplementation(async (_provider, callbacks) => {
		answered.resolve(await callbacks.onPrompt({ message: "Publication-bound code" }));
	});
	let flow: Record<string, unknown> | undefined, waiting: Record<string, unknown> | undefined;
	try {
		if (authorization) {
			flow = record(await authorization.execute("auth.start", { provider: "minimax-code" }));
			waiting = flow;
			for (let i = 0; i < 100 && !waiting.prompt; i++) {
				await Bun.sleep(1);
				waiting = record(await authorization.execute("auth.read", { flowId: flow.id }));
			}
			expect(waiting.prompt).toBeDefined();
		}
		await manager.moveTo(destination.path());
		expect(manager.getCwd()).toBe(path.resolve(destination.path()));
		expect(errors).toHaveLength(2);
		for (const error of errors) expect(error).toBeInstanceOf(Error);
		expect(beforeCalls).toBe(1);
		expect(aborts).toBe(0);
		const fresh = getSessionClientControls(session);
		expect(fresh).not.toBe(old);
		expect(fresh.retired).toBe(false);
		expect(record(fresh).authorization).toBe(authorization);
		await retiredViews(old);
		if (authorization && flow && waiting) {
			await authorization.execute("auth.answer", {
				flowId: flow.id,
				promptId: record(waiting.prompt).id,
				value: "retained-publication-answer",
			});
			expect(await answered.promise).toBe("retained-publication-answer");
			expect(login).toHaveBeenCalledTimes(1);
		}
	} finally {
		login.mockRestore();
		await env.dispose();
	}
});

test.each([
	["before", "validation"],
	["publication", "validation"],
	["before", "invocation"],
	["publication", "invocation"],
] as const)("detached %s callback move cannot outlive uncommitted admission (%s)", async (phase, delay) => {
	const env = await fixture();
	using destination = TempDir.createSync("@sdk-detached-outer-");
	using nested = TempDir.createSync("@sdk-detached-nested-");
	const { session } = env,
		manager = session.sessionManager;
	const old = getSessionClientControls(session),
		authorization = record(old).authorization;
	const release = Promise.withResolvers<void>(),
		releaseInvocation = Promise.withResolvers<void>();
	const outerWaiting = Promise.withResolvers<void>(),
		releaseOuter = Promise.withResolvers<void>();
	const sourceHandle = await SessionManager.openNoFollowDirectory(manager.getCwd());
	const targetHandle = await SessionManager.openNoFollowDirectory(destination.path());
	let publicationReturned = false;
	const removeMarker = manager.registerMovePublicationListener(() => {
		publicationReturned = true;
	});
	const open = SessionManager.openNoFollowDirectory;
	let holdChild = false,
		attempted = false,
		beforeCalls = 0,
		aborts = 0;
	let child: Promise<unknown> | undefined;
	const source = spyOn(SessionManager, "openNoFollowDirectory").mockImplementation(async directory => {
		if (holdChild) await release.promise;
		return open(directory);
	});
	const removeBefore = manager.registerBeforeMoveListener(() => {
		beforeCalls++;
	});
	const removeAbort = manager.registerMoveAbortListener(() => {
		aborts++;
	});
	const listener = () => {
		if (attempted) return;
		attempted = true;
		holdChild = true;
		child = (async () => {
			if (delay === "invocation") await releaseInvocation.promise;
			await manager.moveTo(nested.path());
		})().then(
			() => undefined,
			error => error,
		);
		holdChild = false;
	};
	const remove =
		phase === "before"
			? manager.registerBeforeMoveListener(listener)
			: manager.registerMovePublicationListener(listener);
	let moving: Promise<void> | undefined;
	try {
		moving = manager.moveTo(destination.path(), {
			sourceHandle,
			targetHandle: {
				stat: async (options: { bigint: true }) => {
					if (publicationReturned) {
						outerWaiting.resolve();
						await releaseOuter.promise;
					}
					return await targetHandle.stat(options);
				},
			},
		});
		await outerWaiting.promise;
		expect(manager.getCwd()).toBe(env.cwd);
		release.resolve();
		releaseInvocation.resolve();
		expect(await child).toBeInstanceOf(Error);
		releaseOuter.resolve();
		await moving;
		expect(manager.getCwd()).toBe(path.resolve(destination.path()));
		expect(beforeCalls).toBe(1);
		expect(aborts).toBe(0);
		const fresh = getSessionClientControls(session);
		expect(fresh.retired).toBe(false);
		expect(record(fresh).authorization).toBe(authorization);
		await retiredViews(old);
	} finally {
		release.resolve();
		releaseInvocation.resolve();
		releaseOuter.resolve();
		await child;
		await moving;
		remove();
		removeMarker();
		removeBefore();
		removeAbort();
		source.mockRestore();
		await sourceHandle.close();
		await targetHandle.close();
		await env.dispose();
	}
});

test.each([
	["after", "validation"],
	["abort", "validation"],
	["after", "before"],
	["abort", "before"],
] as const)("native %s writer retains its detached child through %s settlement", async (outcome, phase) => {
	const env = await fixture();
	using first = TempDir.createSync("@sdk-owner-first-");
	using childTarget = TempDir.createSync("@sdk-owner-child-");
	using second = TempDir.createSync("@sdk-owner-second-");
	const { session } = env,
		manager = session.sessionManager;
	const authorization = record(getSessionClientControls(session)).authorization;
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const returned = Promise.withResolvers<void>();
	let attempted = false,
		failPublication = outcome === "abort",
		aborts = 0;
	let rootSettled = false,
		tailSettled = false,
		secondStarted = false;
	let child: Promise<unknown> | undefined,
		root: Promise<unknown> | undefined,
		next: Promise<unknown> | undefined,
		tail: Promise<void> | undefined;
	const rootSource = await SessionManager.openNoFollowDirectory(manager.getCwd());
	const rootTarget = await SessionManager.openNoFollowDirectory(first.path());
	const handles: Array<{ close(): Promise<void> }> = [rootSource, rootTarget];
	const removeFailure = manager.registerMovePublicationListener(() => {
		if (failPublication) {
			failPublication = false;
			throw new Error("first move abort fixture");
		}
	});
	const removeAbort = manager.registerMoveAbortListener(() => {
		aborts++;
	});
	const removeBefore = manager.registerBeforeMoveListener(async move => {
		if (move.newCwd === path.resolve(second.path())) secondStarted = true;
		if (phase === "before" && move.newCwd === path.resolve(childTarget.path())) {
			entered.resolve();
			await release.promise;
		}
	});
	const listener = async () => {
		if (attempted) return;
		attempted = true;
		const source = await SessionManager.openNoFollowDirectory(manager.getCwd());
		const target = await SessionManager.openNoFollowDirectory(childTarget.path());
		handles.push(source, target);
		let calls = 0;
		child = manager
			.moveTo(childTarget.path(), {
				sourceHandle: {
					stat: async (options: { bigint: true }) => {
						if (++calls === 2 && phase === "validation") {
							entered.resolve();
							await release.promise;
						}
						return await source.stat(options);
					},
				},
				targetHandle: target,
			})
			.then(
				() => undefined,
				error => error,
			);
		await entered.promise;
		returned.resolve();
	};
	const remove =
		outcome === "after" ? manager.registerAfterMoveListener(listener) : manager.registerMoveAbortListener(listener);
	try {
		root = manager.moveTo(first.path(), { sourceHandle: rootSource, targetHandle: rootTarget }).then(
			() => {
				rootSettled = true;
				return undefined;
			},
			error => {
				rootSettled = true;
				return error;
			},
		);
		await returned.promise;
		tail = manager.joinCwdTransition().then(() => {
			tailSettled = true;
		});
		// Drain completion microtasks; actual child work remains held by an explicit gate.
		await Bun.sleep(0);
		expect(rootSettled).toBe(false);
		expect(tailSettled).toBe(false);
		unavailable(session);
		next = manager.moveTo(second.path()).then(
			() => undefined,
			error => error,
		);
		await Bun.sleep(0);
		expect(secondStarted).toBe(false);
		release.resolve();
		expect(await child).toBeUndefined();
		const rootResult = await root;
		if (outcome === "abort") expect(String(rootResult)).toContain("first move abort fixture");
		else expect(rootResult).toBeUndefined();
		await tail;
		expect(await next).toBeUndefined();
		expect(aborts).toBe(outcome === "abort" ? 1 : 0);
		expect(manager.getCwd()).toBe(path.resolve(second.path()));
		const fresh = getSessionClientControls(session);
		expect(fresh.retired).toBe(false);
		expect(record(fresh).authorization).toBe(authorization);
	} finally {
		release.resolve();
		await child;
		await root;
		await next;
		await tail;
		remove();
		removeFailure();
		removeBefore();
		removeAbort();
		for (const handle of handles) await handle.close();
		await env.dispose();
	}
});

test("source admission cannot adopt a sibling endpoint after its first handle validation suspends", async () => {
	const env = await fixture();
	using first = TempDir.createSync("@sdk-source-first-");
	using sibling = TempDir.createSync("@sdk-source-sibling-");
	using childTarget = TempDir.createSync("@sdk-source-child-");
	const { session } = env,
		manager = session.sessionManager;
	const authorization = record(getSessionClientControls(session)).authorization;
	let attempted = false,
		aborts = 0;
	let childResult: unknown;
	const removeAbort = manager.registerMoveAbortListener(() => {
		aborts++;
	});
	const removeAfter = manager.registerAfterMoveListener(async () => {
		if (attempted) return;
		attempted = true;
		const source = await SessionManager.openNoFollowDirectory(manager.getCwd());
		const target = await SessionManager.openNoFollowDirectory(childTarget.path());
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let calls = 0;
		const child = manager
			.moveTo(childTarget.path(), {
				sourceHandle: {
					stat: async (options: { bigint: true }) => {
						if (++calls === 1) {
							entered.resolve();
							await release.promise;
						}
						return await source.stat(options);
					},
				},
				targetHandle: target,
			})
			.then(
				() => undefined,
				error => error,
			);
		try {
			await entered.promise;
			await manager.moveTo(sibling.path());
		} finally {
			release.resolve();
			childResult = await child;
			await source.close();
			await target.close();
		}
	});
	try {
		await manager.moveTo(first.path());
		expect(childResult).toBeInstanceOf(Error);
		expect(aborts).toBe(0);
		expect(manager.getCwd()).toBe(path.resolve(sibling.path()));
		const fresh = getSessionClientControls(session);
		expect(fresh.retired).toBe(false);
		expect(record(fresh).authorization).toBe(authorization);
	} finally {
		removeAfter();
		removeAbort();
		await env.dispose();
	}
});

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

test("permanently poisoned SDK owner cannot veto an otherwise valid native cwd move", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("@sdk-poisoned-owner-native-move-");
	const { session } = env,
		manager = session.sessionManager;
	try {
		const old = getSessionClientControls(session);
		const owner = session.getAgentId(),
			sessionId = session.sessionId,
			identity = manager.getSessionIdentityGeneration();
		const target = await fs.realpath(destination.path());
		expect(target).not.toBe(await fs.realpath(manager.getCwd()));
		// Use the same observed mismatch as the permanent-poison regression above.
		const mismatch = spyOn(session, "getAgentId").mockReturnValue("observed-foreign-owner");
		try {
			unavailable(session);
		} finally {
			mismatch.mockRestore();
		}
		expect(session.getAgentId()).toBe(owner);
		unavailable(session);
		unavailable(session);
		expect(old.retired).toBe(true);
		await retiredViews(old);

		// SDK invalidation has no authority to reject a genuine native relocation.
		await manager.moveTo(destination.path());
		expect(manager.getCwd()).toBe(target);
		expect(manager.hasPendingCwdMove()).toBe(false);
		expect(session.sessionManager).toBe(manager);
		expect(session.sessionId).toBe(sessionId);
		expect(manager.getSessionIdentityGeneration()).toBe(identity);
		unavailable(session);
		unavailable(session);
	} finally {
		await env.dispose();
	}
});

test("native cold-retirement fork completes after replacing the SDK lifetime's manager", async () => {
	// Explicit disk storage exercises cold retirement on platforms where managed
	// sidecars are unavailable, without replacing any native manager or callback.
	const env = await fixture("explicit");
	const { session } = env,
		manager = session.sessionManager;
	try {
		const old = getSessionClientControls(session);
		for (let index = 0; index < 4; index++)
			manager.appendMessage({ role: "user", content: `cold prefix ${index}`, timestamp: index + 1 });
		const firstKept = manager.appendMessage({ role: "user", content: "retained fork tail", timestamp: 5 });
		manager.appendCompaction("cold prefix summary", undefined, firstKept, 64);
		await manager.ensureOnDisk();
		await manager.flush();
		const branch = manager.getBranch();
		const messages = manager.buildSessionContext().messages;
		session.agent.replaceMessages(messages);
		const sessionId = session.sessionId,
			owner = session.getAgentId(),
			leaf = manager.getLeafId();
		const sourceFile = manager.getSessionFile();
		if (!sourceFile) throw new Error("Expected a real persisted cold-fork source");
		const canonicalSource = await fs.realpath(sourceFile);
		const canonicalCwd = await fs.realpath(manager.getCwd());

		// Force the production cold path at a small deterministic fixture size;
		// require actual retired entries, not just an enabled setting or a mock.
		session.settings.set("sessionMemory.mode", "enabled");
		expect(manager.getSessionMemoryStats().coldRetirementActive).toBe(true);
		expect(manager.getSessionMemoryStats().coldEntriesRetired).toBeGreaterThan(0);
		expect(getSessionClientControls(session)).toBe(old);

		expect(await session.fork()).toBe(true);
		const successor = session.sessionManager;
		expect(successor).not.toBe(manager);
		expect(session.sessionId).not.toBe(sessionId);
		expect(successor.getSessionId()).toBe(session.sessionId);
		expect(session.getAgentId()).toBe(owner);
		expect(await fs.realpath(successor.getCwd())).toBe(canonicalCwd);
		const forkFile = successor.getSessionFile();
		if (!forkFile) throw new Error("Expected a real persisted cold-fork successor");
		expect(await fs.realpath(forkFile)).not.toBe(canonicalSource);
		expect(await fs.realpath(sourceFile)).toBe(canonicalSource);
		expect(successor.getHeader()?.parentSession).toBe(sessionId);
		expect(successor.getLeafId()).toBe(leaf);
		expect(successor.getBranch()).toEqual(branch);
		expect(session.agent.state.messages).toEqual(messages);
		expect(session.sessionLifecycle.transitioning).toBe(false);
		expect(old.retired).toBe(true);
		await retiredViews(old);
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

test("retiring moved operator views cannot release an unsettled native execution or revive its opaque ID", async () => {
	const env = await fixture();
	using destination = TempDir.createSync("@sdk-control-move-execution-");
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
