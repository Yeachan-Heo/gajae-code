import { expect, test } from "bun:test";
import * as path from "node:path";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import {
	type ChildBridgeOptions,
	type ChildCreateResult,
	loadThread,
	type SessionClient,
	wireCloseCallback,
} from "../../thread-runtime/child-bridge";
import {
	type EndpointAuthority,
	type ThreadEffectiveSettings,
	ThreadRuntimeManager,
} from "../../thread-runtime/thread-runtime-manager";

const authority = (gen: number): EndpointAuthority => ({
	endpointGeneration: gen,
	endpointIncarnation: "b".repeat(64),
	endpointMtimeMs: Date.now(),
	pid: 54321,
});

const settings = (sessionId: string, cwd: string): ThreadEffectiveSettings => ({
	model: "gpt",
	modelProvider: "openai",
	serviceTier: null,
	cwd,
	instructionSources: [],
	approvalPolicy: "untrusted",
	approvalsReviewer: "user",
	sandbox: { type: "dangerFullAccess" },
	reasoningEffort: null,
	thread: {
		id: sessionId,
		sessionId,
		forkedFromId: null,
		parentThreadId: null,
		preview: "preview",
		ephemeral: false,
		isPinned: false,
		modelProvider: "openai",
		createdAt: 0,
		updatedAt: 0,
		recencyAt: null,
		status: { type: "idle" },
		path: null,
		cwd,
		cliVersion: "1",
		source: "cli",
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: null,
		name: null,
		turns: [],
		extra: null,
		historyMode: "paginated",
		canAcceptDirectInput: true,
	},
});

function fakeClient(counters: { close: number }): SessionClient {
	return {
		onFrame: () => () => {},
		onReconnect: () => () => {},
		onReconnectFailed: () => () => {},
		request: async () => ({}),
		query: async () => ({}),
		control: async () => ({}),
		close: async () => {
			counters.close++;
		},
	};
}

test("loadThread: acquires token, spawns child, registers thread, releases token", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4, spawnSemaphore: 1 });
	let closeCalls = 0;
	const opts: ChildBridgeOptions = {
		manager,
		spawn: async (_id, _ownership) => authority(1),
		close: async () => {
			closeCalls += 1;
		},
	};
	await loadThread(opts, "t1", "spawned", "conn-a");
	expect(manager.get("t1")).toBeDefined();
	expect(manager.get("t1")?.authority?.endpointGeneration).toBe(1);
	manager.terminate("t1");
	await Bun.sleep(0);
	expect(closeCalls).toBe(1);
});

test("loadThread: legacy spawned path rejects before spawn when no child closer exists", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	let spawnCalls = 0;
	await expect(
		loadThread(
			{
				manager,
				spawn: async () => {
					spawnCalls += 1;
					return authority(1);
				},
			},
			"missing-closer",
			"spawned",
		),
	).rejects.toThrow("requires authority-fenced cleanup");
	expect(spawnCalls).toBe(0);
	expect(manager.loadedCount).toBe(0);
});
test("loadThread: spawn failure releases the token without registering", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4, spawnSemaphore: 1 });
	const opts: ChildBridgeOptions = {
		manager,
		spawn: async () => {
			throw new Error("spawn failed");
		},
		close: async () => {},
	};
	await expect(loadThread(opts, "t1", "spawned")).rejects.toThrow("spawn failed");
	expect(manager.get("t1")).toBeUndefined();
	// Token was released, so a new load succeeds.
	const opts2: ChildBridgeOptions = { manager, spawn: async () => authority(2), close: async () => {} };
	await loadThread(opts2, "t2", "spawned");
	expect(manager.get("t2")).toBeDefined();
});

test("loadThread: spawn semaphore bounds concurrent loads", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 10, spawnSemaphore: 1 });
	let resolveSpawn: () => void = () => {};
	const opts: ChildBridgeOptions = {
		manager,
		spawn: () =>
			new Promise<EndpointAuthority>(resolve => {
				resolveSpawn = () => resolve(authority(1));
			}),
		close: async () => {},
	};
	// Start first load — it blocks in spawn (never resolves until we call resolveSpawn).
	const first = loadThread(opts, "t1", "spawned");
	await new Promise(r => setTimeout(r, 10));
	// Second load must fail because the semaphore token is held by the first.
	await expect(loadThread(opts, "t2", "spawned")).rejects.toThrow(/semaphore exhausted/);
	// Resolve the first spawn.
	resolveSpawn();
	await first;
	expect(manager.get("t1")).toBeDefined();
});

test("wireCloseCallback: eviction triggers the close function with captured authority", async () => {
	const closed: Array<{ id: string; auth?: EndpointAuthority }> = [];
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 1, idleTtlMs: 0 });
	const opts: ChildBridgeOptions = {
		manager,
		spawn: async (_id, _ownership) => authority(42),
		close: async (id, _ownership, auth) => {
			closed.push({ id, auth });
		},
	};
	wireCloseCallback(opts);
	await loadThread(opts, "t1", "spawned");
	// Evict via capacity pressure (idleTtlMs=0, so t1 is immediately evictable).
	await loadThread(opts, "t2", "spawned");
	expect(closed.some(c => c.id === "t1" && c.auth?.endpointGeneration === 42)).toBe(true);
});

test("loadThread: attached ownership (resume) registers without a spawned child", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 4 });
	const opts: ChildBridgeOptions = {
		manager,
		spawn: async () => undefined, // attached: no real child spawn, no authority
	};
	await loadThread(opts, "t1", "attached");
	expect(manager.get("t1")?.ownership).toBe("attached");
	expect(manager.get("t1")?.authority).toBeUndefined();
});

test("transactional load: readiness, effective settings, publication, and subscription are ordered", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0, attach: 0 };
	const order: string[] = [];
	const sessionId = "session-transaction";
	const cwd = path.resolve("component-cwd");
	const client = fakeClient(counters);
	const childAuthority = authority(7);
	const opts: ChildBridgeOptions = {
		manager,
		create: async request => {
			order.push("create");
			expect(request.cwd).toBe(cwd);
			expect(request.idempotencyKey).toBe("stable-key");
			return {
				sessionId,
				cwd,
				authority: childAuthority,
				client,
				awaitReady: async () => {
					order.push("ready");
				},
				closeChild: async () => {
					counters.childClose++;
				},
			};
		},
		attachReverseLeaseController: async () => {
			order.push("attach");
			counters.attach++;
		},
		readEffectiveSettings: async () => {
			order.push("settings");
			expect(manager.get(sessionId)).toBeUndefined();
			expect(manager.pendingCount).toBe(1);
			return settings(sessionId, cwd);
		},
		subscribe: async id => {
			order.push("subscribe");
			expect(manager.get(id)?.client).toBe(client);
			expect(manager.get(id)?.authority?.endpointGeneration).toBe(7);
		},
	};
	const runtime = await loadThread(opts, {
		connectionId: "conn-a",
		cwd: "component-cwd",
		idempotencyKey: "stable-key",
	});
	expect(order).toEqual(["create", "ready", "attach", "settings", "subscribe"]);
	expect(runtime.sessionId).toBe(sessionId);
	expect(runtime.cwd).toBe(cwd);
	expect(runtime.authority).toEqual(childAuthority);
	expect(runtime.client).toBe(client);
	expect(stableValidators.clientRequestResults["thread/start"](runtime.response)).toBe(true);
	expect(runtime.response.thread).toMatchObject({ id: sessionId, sessionId });
	expect(counters.attach).toBe(1);
	expect(manager.loadedCount).toBe(1);
	expect(manager.pendingCount).toBe(0);
	manager.terminate(sessionId);
	await Bun.sleep(0);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
});

test("transactional load: create failure before a client leaves admission and subscriptions untouched", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	let subscriptions = 0;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => {
			throw new Error("create failed");
		},
		subscribe: async () => {
			subscriptions++;
		},
	};
	await expect(loadThread(opts, { connectionId: "conn-create-fail" })).rejects.toThrow("create failed");
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
	expect(subscriptions).toBe(0);
});

test("transactional load: readiness failure closes client and owned child and releases admission", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-readiness-fail",
			cwd: path.resolve("cwd"),
			authority: authority(8),
			client: fakeClient(counters),
			awaitReady: async () => {
				throw new Error("not ready");
			},
			closeChild: async () => {
				counters.childClose++;
			},
		}),
	};
	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("not ready");
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});

test("transactional load: reverse-lease attachment failure closes the ready child before settings", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	const childAuthority = authority(13);
	let settingsReads = 0;
	let closedAuthority: EndpointAuthority | undefined;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-lease-fail",
			cwd: path.resolve("cwd"),
			authority: childAuthority,
			client: fakeClient(counters),
			awaitReady: async () => {},
			closeChild: async captured => {
				closedAuthority = captured;
				counters.childClose += 1;
			},
		}),
		attachReverseLeaseController: async () => {
			throw new Error("lease attachment failed");
		},
		readEffectiveSettings: async () => {
			settingsReads += 1;
			return settings("session-lease-fail", path.resolve("cwd"));
		},
	};

	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("lease attachment failed");
	expect(settingsReads).toBe(0);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(closedAuthority).toEqual(childAuthority);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});

test("transactional load: effective-settings failure after readiness closes with exact authority", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	let closedAuthority: EndpointAuthority | undefined;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-settings-fail",
			cwd: path.resolve("cwd"),
			authority: authority(10),
			client: fakeClient(counters),
			awaitReady: async () => {},
			closeChild: async captured => {
				closedAuthority = captured;
				counters.childClose++;
			},
		}),
		readEffectiveSettings: async () => {
			throw new Error("settings failed");
		},
	};
	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("settings failed");
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(closedAuthority?.endpointGeneration).toBe(10);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});

test("transactional load: duplicate session publication closes the duplicate runtime", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 3 });
	const first = { close: 0, childClose: 0 };
	const duplicate = { close: 0, childClose: 0 };
	let duplicateAuthority: EndpointAuthority | undefined;
	let attempt = 0;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => {
			attempt++;
			const counters = attempt === 1 ? first : duplicate;
			const childAuthority = authority(attempt);
			return {
				sessionId: "same-session",
				cwd: path.resolve("cwd"),
				authority: childAuthority,
				client: fakeClient(counters),
				awaitReady: async () => {},
				closeChild: async captured => {
					if (attempt > 1) duplicateAuthority = captured;
					counters.childClose++;
				},
			};
		},
		readEffectiveSettings: async () => settings("same-session", path.resolve("cwd")),
	};
	await loadThread(opts, { threadId: "first" });
	await expect(loadThread(opts, { threadId: "second" })).rejects.toThrow(/already loaded/);
	expect(manager.loadedCount).toBe(1);
	expect(manager.pendingCount).toBe(0);
	expect(duplicate.close).toBe(1);
	expect(duplicate.childClose).toBe(1);
	expect(first.close).toBe(0);
	expect(duplicateAuthority?.endpointGeneration).toBe(2);
});

test("transactional load: subscribe failure removes publication and rolls back the subscription", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	let closedAuthority: EndpointAuthority | undefined;
	let unsubscribed = 0;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-subscribe-fail",
			cwd: path.resolve("cwd"),
			authority: authority(9),
			client: fakeClient(counters),
			awaitReady: async () => {},
			closeChild: async captured => {
				closedAuthority = captured;
				counters.childClose++;
			},
		}),
		readEffectiveSettings: async () => settings("session-subscribe-fail", path.resolve("cwd")),
		subscribe: async () => {
			throw new Error("subscribe failed");
		},
		unsubscribe: async () => {
			unsubscribed++;
		},
	};
	await expect(loadThread(opts, { connectionId: "conn-a" })).rejects.toThrow("subscribe failed");
	expect(unsubscribed).toBe(1);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(closedAuthority?.endpointGeneration).toBe(9);
});

test("transactional load: experimental workspace roots must be an own effective-settings field", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	const sessionId = "session-inherited-workspace-roots";
	const cwd = path.resolve("cwd");
	const inheritedSettings = Object.assign(Object.create({ runtimeWorkspaceRoots: [] }), settings(sessionId, cwd), {
		activePermissionProfile: null,
		multiAgentMode: "proactive",
	}) as ThreadEffectiveSettings;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId,
			cwd,
			authority: authority(14),
			client: fakeClient(counters),
			awaitReady: async () => {},
			closeChild: async () => {
				counters.childClose += 1;
			},
			effectiveSettings: inheritedSettings,
		}),
	};

	await expect(loadThread(opts, { cwd, experimentalApi: true })).rejects.toThrow("missing runtimeWorkspaceRoots");
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});
test("transactional load: malformed session id captures cleanup before validation", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	let readyCalls = 0;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "",
			cwd: path.resolve("cwd"),
			authority: authority(21),
			client: fakeClient(counters),
			awaitReady: async () => {
				readyCalls++;
			},
			closeChild: async () => {
				counters.childClose++;
			},
		}),
	};
	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("did not provide sessionId");
	expect(readyCalls).toBe(0);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});

test("transactional load: malformed cwd captures cleanup before validation", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	let readyCalls = 0;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-invalid-cwd",
			cwd: "",
			authority: authority(22),
			client: fakeClient(counters),
			awaitReady: async () => {
				readyCalls++;
			},
			closeChild: async () => {
				counters.childClose++;
			},
		}),
	};
	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("did not provide cwd");
	expect(readyCalls).toBe(0);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});

test("transactional load: missing client still closes a spawned child", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	let readyCalls = 0;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-missing-client",
			cwd: path.resolve("cwd"),
			authority: authority(23),
			client: undefined as unknown as SessionClient,
			awaitReady: async () => {
				readyCalls++;
			},
			closeChild: async () => {
				counters.childClose++;
			},
		}),
	};
	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("did not retain a session client");
	expect(readyCalls).toBe(0);
	expect(counters.close).toBe(0);
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});

test("transactional load: invalid retained-client methods fail before readiness", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	const client = fakeClient(counters);
	(client as unknown as Record<string, unknown>).request = 1;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-invalid-client-method",
			cwd: path.resolve("cwd"),
			authority: authority(25),
			client,
			awaitReady: async () => {},
			closeChild: async () => {
				counters.childClose += 1;
			},
		}),
	};

	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("missing request()");
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
});

test("transactional load: observer registration must return callable disposers", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	const client: SessionClient = {
		...fakeClient(counters),
		onFrame: (() => 42) as unknown as SessionClient["onFrame"],
	};
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-invalid-disposer",
			cwd: path.resolve("cwd"),
			authority: authority(26),
			client,
			awaitReady: async () => {},
			closeChild: async () => {
				counters.childClose += 1;
			},
		}),
	};

	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("onFrame() did not return a disposer");
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
});

test("transactional load: malformed reverse-lease attachments fail closed", async () => {
	for (const [index, attachment] of [{}, { ownsClient: true }, 1].entries()) {
		const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
		const counters = { close: 0, childClose: 0 };
		const sessionId = `session-invalid-attachment-${index}`;
		const opts: ChildBridgeOptions = {
			manager,
			create: async () => ({
				sessionId,
				cwd: path.resolve("cwd"),
				authority: authority(30 + index),
				client: fakeClient(counters),
				awaitReady: async () => {},
				closeChild: async () => {
					counters.childClose += 1;
				},
			}),
			attachReverseLeaseController: async () => attachment as never,
		};

		await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow(/attachment/);
		expect(counters.close).toBe(1);
		expect(counters.childClose).toBe(1);
		expect(manager.loadedCount).toBe(0);
	}
});

test("transactional load: a throwing attachment ownership accessor cannot skip downstream cleanup", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	let attachmentClose = 0;
	const attachment = {
		close: async () => {
			attachmentClose += 1;
		},
	};
	Object.defineProperty(attachment, "ownsClient", {
		get: () => {
			throw new Error("ownsClient getter failed");
		},
	});
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-attachment-getter",
			cwd: path.resolve("cwd"),
			authority: authority(34),
			client: fakeClient(counters),
			awaitReady: async () => {},
			closeChild: async () => {
				counters.childClose += 1;
			},
		}),
		attachReverseLeaseController: async () => attachment,
	};

	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("ownsClient getter failed");
	expect(attachmentClose).toBe(1);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
});

test("transactional load: undefined thrown by an attachment accessor still rejects and cleans up", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	let attachmentClose = 0;
	const attachment = {
		close: async () => {
			attachmentClose += 1;
		},
	};
	Object.defineProperty(attachment, "ownsClient", {
		get: () => {
			throw undefined;
		},
	});
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-attachment-undefined-throw",
			cwd: path.resolve("cwd"),
			authority: authority(37),
			client: fakeClient(counters),
			awaitReady: async () => {},
			closeChild: async () => {
				counters.childClose += 1;
			},
		}),
		attachReverseLeaseController: async () => attachment,
	};
	let rejected = false;
	try {
		await loadThread(opts, { cwd: "cwd" });
	} catch (error) {
		rejected = true;
		expect(error).toBeUndefined();
	}

	expect(rejected).toBe(true);
	expect(attachmentClose).toBe(1);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
});

test("transactional load: failed client-owning attachment close falls back to direct client close", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	let attachmentClose = 0;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-attachment-close-fail",
			cwd: path.resolve("cwd"),
			authority: authority(35),
			client: fakeClient(counters),
			awaitReady: async () => {},
			closeChild: async () => {
				counters.childClose += 1;
			},
		}),
		attachReverseLeaseController: async () => ({
			ownsClient: true,
			close: async () => {
				attachmentClose += 1;
				throw new Error("attachment close failed");
			},
		}),
		readEffectiveSettings: async () => {
			throw new Error("settings failed");
		},
	};

	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("settings failed");
	expect(attachmentClose).toBe(1);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
});

test("transactional load: throwing child accessors do not hide independently readable cleanup", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	const child = {
		sessionId: "session-throwing-client-getter",
		cwd: path.resolve("cwd"),
		authority: authority(36),
		awaitReady: async () => {},
		closeChild: async () => {
			counters.childClose += 1;
		},
	};
	Object.defineProperty(child, "client", {
		get: () => {
			throw new Error("client getter failed");
		},
	});
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => child as unknown as ChildCreateResult,
	};

	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("client getter failed");
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});

test("transactional load: nested authority accessor failures still invoke captured cleanup", async () => {
	for (const [index, thrown] of [new Error("authority getter failed"), undefined].entries()) {
		const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
		const counters = { close: 0, childClose: 0 };
		const capturedAuthorities: Array<EndpointAuthority | undefined> = [];
		const hostileAuthority: Record<string, unknown> = {
			endpointIncarnation: "e".repeat(64),
			endpointMtimeMs: 1,
			pid: 1234,
		};
		Object.defineProperty(hostileAuthority, "endpointGeneration", {
			get: () => {
				throw thrown;
			},
		});
		const opts: ChildBridgeOptions = {
			manager,
			create: async () => ({
				sessionId: `session-hostile-authority-${index}`,
				cwd: path.resolve("cwd"),
				authority: hostileAuthority as unknown as EndpointAuthority,
				client: fakeClient(counters),
				awaitReady: async () => {},
				closeChild: async captured => {
					capturedAuthorities.push(captured);
					counters.childClose += 1;
				},
			}),
		};
		let rejected = false;
		let rejection: unknown;
		try {
			await loadThread(opts, { cwd: "cwd" });
		} catch (error) {
			rejected = true;
			rejection = error;
		}

		expect(rejected).toBe(true);
		expect(rejection).toBe(thrown);
		expect(counters.close).toBe(1);
		expect(counters.childClose).toBe(1);
		expect(capturedAuthorities).toEqual([undefined]);
		expect(manager.loadedCount).toBe(0);
		expect(manager.pendingCount).toBe(0);
	}
});

test("transactional load: revoked authority proxies cannot bypass captured cleanup", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	const capturedAuthorities: Array<EndpointAuthority | undefined> = [];
	const revocable = Proxy.revocable(authority(38), {});
	revocable.revoke();
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-revoked-authority",
			cwd: path.resolve("cwd"),
			authority: revocable.proxy,
			client: fakeClient(counters),
			awaitReady: async () => {},
			closeChild: async captured => {
				capturedAuthorities.push(captured);
				counters.childClose += 1;
			},
		}),
	};
	let rejection: unknown;
	try {
		await loadThread(opts, { cwd: "cwd" });
	} catch (error) {
		rejection = error;
	}

	expect(rejection).toBeInstanceOf(TypeError);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(capturedAuthorities).toEqual([undefined]);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});

test("transactional load: spawned child without authority-fenced cleanup fails before readiness", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0 };
	let readyCalls = 0;
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-missing-closer",
			cwd: path.resolve("cwd"),
			authority: authority(24),
			client: fakeClient(counters),
			awaitReady: async () => {
				readyCalls++;
			},
		}),
	};
	await expect(loadThread(opts, { cwd: "cwd" })).rejects.toThrow("authority-fenced cleanup");
	expect(readyCalls).toBe(0);
	expect(counters.close).toBe(1);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});

test("transactional load: committing publication is protected from cross-connection eviction", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 1, idleTtlMs: 0 });
	const firstCounters = { close: 0, childClose: 0 };
	const secondCounters = { close: 0, childClose: 0 };
	let releaseSubscribe: () => void = () => {};
	let subscribeStarted: () => void = () => {};
	const started = new Promise<void>(resolve => {
		subscribeStarted = resolve;
	});
	const blocked = new Promise<void>(resolve => {
		releaseSubscribe = resolve;
	});
	const createChild = async (threadId: string, counters: { close: number; childClose: number }) => ({
		sessionId: threadId,
		cwd: path.resolve(threadId),
		authority: authority(threadId === "thread-a" ? 25 : 26),
		client: fakeClient(counters),
		awaitReady: async () => {},
		closeChild: async () => {
			counters.childClose++;
		},
	});
	const optsA: ChildBridgeOptions = {
		manager,
		create: request => createChild(request.threadId ?? "missing-thread", firstCounters),
		readEffectiveSettings: async (_client, child) => settings(child.sessionId, child.cwd),
		subscribe: async threadId => {
			expect(threadId).toBe("thread-a");
			subscribeStarted();
			await blocked;
		},
	};
	const optsB: ChildBridgeOptions = {
		manager,
		create: request => createChild(request.threadId ?? "missing-thread", secondCounters),
		readEffectiveSettings: async (_client, child) => settings(child.sessionId, child.cwd),
	};
	const first = loadThread(optsA, { threadId: "thread-a", connectionId: "conn-a" });
	await started;
	expect(manager.get("thread-a")?.lifecycle).toBe("committing");

	let secondFailure: unknown;
	try {
		await loadThread(optsB, { threadId: "thread-b", connectionId: "conn-b" });
	} catch (error) {
		secondFailure = error;
	} finally {
		releaseSubscribe();
	}
	expect(secondFailure).toBeDefined();
	expect((secondFailure as { code?: string }).code).toBe("conflict");
	expect(manager.get("thread-a")).toBeDefined();
	expect(firstCounters.close).toBe(0);
	expect(firstCounters.childClose).toBe(0);

	await first;
	expect(manager.get("thread-a")?.lifecycle).toBe("active");
	await loadThread(optsB, { threadId: "thread-b", connectionId: "conn-b" });
	expect(manager.get("thread-a")).toBeUndefined();
	expect(manager.get("thread-b")?.lifecycle).toBe("active");
	await Bun.sleep(0);
	expect(firstCounters.close).toBe(1);
	expect(firstCounters.childClose).toBe(1);
});
test("transactional load: lost ownership after subscribe fails closed", async () => {
	const manager = new ThreadRuntimeManager({ maxLoadedThreads: 2 });
	const counters = { close: 0, childClose: 0 };
	let releaseSubscribe: () => void = () => {};
	let subscribeStarted: () => void = () => {};
	let unsubscribed = 0;
	const started = new Promise<void>(resolve => {
		subscribeStarted = resolve;
	});
	const blocked = new Promise<void>(resolve => {
		releaseSubscribe = resolve;
	});
	const opts: ChildBridgeOptions = {
		manager,
		create: async () => ({
			sessionId: "session-lost",
			cwd: path.resolve("cwd"),
			authority: authority(27),
			client: fakeClient(counters),
			awaitReady: async () => {},
			closeChild: async () => {
				counters.childClose++;
			},
		}),
		readEffectiveSettings: async () => settings("session-lost", path.resolve("cwd")),
		subscribe: async () => {
			subscribeStarted();
			await blocked;
		},
		unsubscribe: async () => {
			unsubscribed++;
		},
	};
	const load = loadThread(opts, { threadId: "session-lost" });
	await started;
	expect(manager.get("session-lost")?.lifecycle).toBe("committing");
	manager.remove("session-lost", false);
	releaseSubscribe();
	await expect(load).rejects.toThrow("publication was lost");
	expect(unsubscribed).toBe(1);
	expect(counters.close).toBe(1);
	expect(counters.childClose).toBe(1);
	expect(manager.loadedCount).toBe(0);
	expect(manager.pendingCount).toBe(0);
});
