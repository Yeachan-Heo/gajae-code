import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { Settings } from "../../src/config/settings";
import * as mcpClient from "../../src/runtime-mcp/client";
import { MCPManager } from "../../src/runtime-mcp/manager";
import { MCPConnectionPool } from "../../src/runtime-mcp/pool";
import { legacyEraObservation } from "../../src/runtime-mcp/protocol";
import { attachExactMcpControls, getExactMcpControls, revokeExactMcpControls } from "../../src/runtime-mcp/redaction";
import { DeferredMCPTool, MCPTool } from "../../src/runtime-mcp/tool-bridge";
import type {
	MCPServerConnection,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPTransport,
} from "../../src/runtime-mcp/types";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";

const managers: MCPManager[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.disconnectAll();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function connection(name: string, calls: string[]): MCPServerConnection {
	let connected = true;
	const transport: MCPTransport = {
		get connected() {
			return connected;
		},
		request: (async method => {
			calls.push(method);
			return { content: [{ type: "text", text: "ok" }] } satisfies MCPToolCallResult;
		}) as MCPTransport["request"],
		async notify() {},
		async close() {
			connected = false;
		},
	};
	return {
		name,
		config: { type: "http", url: "http://127.0.0.1:1" },
		transport,
		serverInfo: { name, version: "1" },
		capabilities: { tools: {} },
		protocol: legacyEraObservation({
			preference: "auto",
			effectiveVersion: "2025-03-26",
			negotiation: "legacy-fallback",
			downgradeReason: "legacy-server-signal",
			serverInfo: { name, version: "1" },
			capabilities: { tools: true },
		}),
	};
}

async function exactSessionFixture(providerSessionId?: string, persistent = false) {
	const root = await mkdtemp(join(tmpdir(), "gjc-exact-mcp-lifecycle-"));
	roots.push(root);
	const configPath = join(root, "mcp.json");
	await Bun.write(configPath, JSON.stringify({ mcpServers: { exact: { type: "http", url: "http://127.0.0.1:1" } } }));
	const calls: string[] = [];
	const live = connection("exact", calls);
	vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(live);
	vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "lookup", inputSchema: { type: "object" } }]);
	const manager = new MCPManager(root, null, { toolsOnly: true });
	managers.push(manager);
	await manager.discoverAndConnect({ configPath });
	const model: Model<"openai-responses"> = {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
	const leaseEntered = Promise.withResolvers<void>();
	const releaseLease = Promise.withResolvers<void>();
	let pauseNextLease = false;
	const sessionManager = persistent ? SessionManager.create(root, root) : SessionManager.inMemory(root);
	if (persistent) await sessionManager.ensureOnDisk();
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["initial"], tools: [], messages: [] } }),
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry: {
			withConsumerLease: async <T>(body: () => T | Promise<T>): Promise<T> => {
				if (pauseNextLease) {
					pauseNextLease = false;
					leaseEntered.resolve();
					await releaseLease.promise;
				}
				return await body();
			},
		} as never,
		toolRegistry: new Map(),
		ownedMcpManager: manager,
		providerSessionId,
	});
	attachExactMcpControls(session, { grantSource: "root-interactive-exact-config", configPath });
	return {
		session,
		sessionManager,
		manager,
		root,
		live,
		calls,
		leaseEntered,
		releaseLease,
		pauseLease: () => {
			pauseNextLease = true;
		},
	};
}

describe("pool lease request handler", () => {
	test("keeps the physical roots handler on the lease facade", async () => {
		const physical = connection("pooled", []);
		const onRequest = async (method: string) => {
			throw new Error(`rejected ${method}`);
		};
		const pool = new MCPConnectionPool({ connect: async () => physical });
		const lease = await pool.acquire("pooled", physical.config, {
			sessionId: "session-1",
			capabilityProfile: "tools-only",
			onRequest,
		});
		try {
			const handler = lease.connectionForLease().transport.onRequest;
			expect(typeof handler).toBe("function");
			await expect(handler!("roots/list", undefined)).rejects.toThrow(/rejected roots\/list/);
		} finally {
			await lease.release();
		}
	});
});

describe("exact-config MCP session controls", () => {
	for (const providerSessionId of [undefined, "provider-visible-override"]) {
		for (const operation of ["status", "control"] as const) {
			for (const retirementFails of [false, true]) {
				test(`queued ${operation} refuses successor identity (provider override: ${Boolean(providerSessionId)}, retirement failure: ${retirementFails})`, async () => {
					const fixture = await exactSessionFixture(providerSessionId);
					const { session, sessionManager, manager, leaseEntered, releaseLease } = fixture;
					const originalId = sessionManager.getSessionId();
					const originalGrant = getExactMcpControls(session);
					if (!originalGrant) throw new Error("Expected exact MCP controls on the predecessor");
					const readNames = vi.spyOn(manager, "getAllServerNames");
					const prepare = vi.spyOn(manager, "prepareExactServerControl");
					if (retirementFails) {
						const reset = manager.prepareExactServerControlReset.bind(manager);
						vi.spyOn(manager, "prepareExactServerControlReset").mockImplementation(async () => {
							const prepared = await reset();
							return {
								...prepared,
								commit: async () => {
									throw new Error("injected retirement commit failure");
								},
							};
						});
					}
					fixture.pauseLease();
					const queued =
						operation === "status"
							? session.getExactMcpStatusSnapshot()
							: session.controlExactMcpServer("suspend", "exact");
					void queued.catch(() => {});
					try {
						await leaseEntered.promise;
						expect(sessionManager.getSessionId()).toBe(originalId);
						if (retirementFails)
							await expect(session.newSession()).rejects.toThrow("injected retirement commit failure");
						else await expect(session.newSession()).resolves.toBe(true);
						expect(sessionManager.getSessionId()).not.toBe(originalId);
						if (providerSessionId) expect(session.sessionId).toBe(providerSessionId);
						const successorGrant = getExactMcpControls(session);
						if (retirementFails && successorGrant) expect(successorGrant).toBe(originalGrant);
						else expect(successorGrant).toBeUndefined();
						readNames.mockClear();
						prepare.mockClear();
						releaseLease.resolve();
						await expect(queued).resolves.toBeUndefined();
						expect(readNames).not.toHaveBeenCalled();
						expect(prepare).not.toHaveBeenCalled();
						expect(manager.isExactServerSuppressed("exact")).toBe(false);
						expect(fixture.live.transport.connected).toBe(true);
						expect(fixture.calls).toEqual([]);
					} finally {
						releaseLease.resolve();
						await Promise.allSettled([queued]);
						await session.dispose();
					}
				});
			}
		}
	}

	test("disposal revokes fresh controls and retains the manager until an admitted control settles", async () => {
		const { session, manager, live } = await exactSessionFixture();
		const controlStarted = Promise.withResolvers<void>();
		const releaseControl = Promise.withResolvers<void>();
		const prepare = manager.prepareExactServerControl.bind(manager);
		const prepareSpy = vi.spyOn(manager, "prepareExactServerControl").mockImplementation(async (action, name) => {
			const prepared = await prepare(action, name);
			controlStarted.resolve();
			await releaseControl.promise;
			return prepared;
		});
		const releaseSpy = vi.spyOn(manager, "releaseLeases");
		session.setDisposeTimeoutForTests(50);
		const control = session.controlExactMcpServer("suspend", "exact");
		void control.catch(() => {});
		await controlStarted.promise;
		expect(manager.getToolCatalogSnapshot().publication).toBe("fenced");
		vi.useFakeTimers();
		try {
			const disposal = session.dispose();
			void disposal.catch(() => {});
			let completionSettled = false;
			const completion = session.awaitDisposeCompletion().finally(() => {
				completionSettled = true;
			});
			void completion.catch(() => {});
			expect(session.hasExactMcpControls).toBe(false);
			await expect(session.getExactMcpStatusSnapshot()).resolves.toBeUndefined();
			await expect(session.controlExactMcpServer("suspend", "exact")).resolves.toBeUndefined();
			expect(prepareSpy).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(50);
			await expect(disposal).rejects.toMatchObject({ name: "SessionDisposalIncompleteError" });
			expect(completionSettled).toBe(false);
			expect(releaseSpy).not.toHaveBeenCalled();
			expect(live.transport.connected).toBe(true);
			releaseControl.resolve();
			await expect(control).resolves.toMatchObject({ action: "suspend", name: "exact", status: "suspended" });
			await completion;
			expect(releaseSpy).toHaveBeenCalledTimes(1);
			expect(live.transport.connected).toBe(false);
			await expect(session.dispose()).resolves.toBeUndefined();
		} finally {
			releaseControl.resolve();
			vi.useRealTimers();
			await Promise.allSettled([control, session.awaitDisposeCompletion()]);
		}
	});

	test("disposal joins an MCP admission still waiting for its model lease", async () => {
		const fixture = await exactSessionFixture();
		const { session, manager, live, leaseEntered, releaseLease } = fixture;
		const release = vi.spyOn(manager, "releaseLeases");
		const prepare = vi.spyOn(manager, "prepareExactServerControl");
		fixture.pauseLease();
		const control = session.controlExactMcpServer("suspend", "exact");
		void control.catch(() => {});
		await leaseEntered.promise;
		session.setDisposeTimeoutForTests(50);
		vi.useFakeTimers();
		try {
			const disposal = session.dispose();
			void disposal.catch(() => {});
			let settled = false;
			const completion = session.awaitDisposeCompletion().finally(() => {
				settled = true;
			});
			void completion.catch(() => {});
			vi.advanceTimersByTime(50);
			await expect(disposal).rejects.toMatchObject({ name: "SessionDisposalIncompleteError" });
			expect(settled).toBe(false);
			expect(release).not.toHaveBeenCalled();
			expect(live.transport.connected).toBe(true);
			releaseLease.resolve();
			await expect(control).resolves.toBeUndefined();
			await completion;
			expect(prepare).not.toHaveBeenCalled();
			expect(release).toHaveBeenCalledTimes(1);
			expect(live.transport.connected).toBe(false);
		} finally {
			releaseLease.resolve();
			vi.useRealTimers();
			await Promise.allSettled([control, session.awaitDisposeCompletion()]);
		}
	});

	for (const failure of [false, true]) {
		test(`retirement ${failure ? "failure after adoption" : "commit"} revokes a concurrently attached grant`, async () => {
			const { session, sessionManager, manager } = await exactSessionFixture();
			const originalId = sessionManager.getSessionId();
			const originalGrant = getExactMcpControls(session);
			if (!originalGrant) throw new Error("Expected exact MCP controls");
			const commitStarted = Promise.withResolvers<void>();
			const releaseCommit = Promise.withResolvers<void>();
			const reset = manager.prepareExactServerControlReset.bind(manager);
			vi.spyOn(manager, "prepareExactServerControlReset").mockImplementation(async () => {
				const prepared = await reset();
				return {
					...prepared,
					commit: async () => {
						commitStarted.resolve();
						await releaseCommit.promise;
						if (failure) throw new Error("injected retirement failure after adoption");
						await prepared.commit();
					},
				};
			});
			const transition = session.newSession();
			void transition.catch(() => {});
			try {
				await commitStarted.promise;
				expect(sessionManager.getSessionId()).not.toBe(originalId);
				attachExactMcpControls(session, { ...originalGrant });
				releaseCommit.resolve();
				if (failure) await expect(transition).rejects.toThrow("injected retirement failure after adoption");
				else await expect(transition).resolves.toBe(true);
				expect(getExactMcpControls(session)).toBeUndefined();
				await expect(session.getExactMcpStatusSnapshot()).resolves.toBeUndefined();
				await expect(session.controlExactMcpServer("suspend", "exact")).resolves.toBeUndefined();
			} finally {
				releaseCommit.resolve();
				await Promise.allSettled([transition]);
				await session.dispose();
			}
		});
	}

	test("a retirement rejected before adoption preserves the predecessor grant", async () => {
		const { session, sessionManager, manager } = await exactSessionFixture();
		const originalId = sessionManager.getSessionId();
		const grant = getExactMcpControls(session);
		const reset = manager.prepareExactServerControlReset.bind(manager);
		vi.spyOn(manager, "prepareExactServerControlReset").mockImplementation(async () => {
			const prepared = await reset();
			return { ...prepared, canCommit: () => false };
		});
		try {
			await expect(session.newSession()).rejects.toThrow(
				"Exact MCP control retirement changed before session adoption",
			);
			expect(sessionManager.getSessionId()).toBe(originalId);
			expect(getExactMcpControls(session)).toBe(grant);
			expect(await session.getExactMcpStatusSnapshot()).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	test("a grant attached after retirement sees no grant cannot authorize the successor", async () => {
		const { session, sessionManager } = await exactSessionFixture();
		const originalId = sessionManager.getSessionId();
		const grant = getExactMcpControls(session);
		if (!grant) throw new Error("Expected exact MCP controls");
		revokeExactMcpControls(session);
		const commit = sessionManager.commitPreparedNewSession.bind(sessionManager);
		vi.spyOn(sessionManager, "commitPreparedNewSession").mockImplementation(prepared => {
			// Retirement has returned without a grant; attach immediately before adoption.
			attachExactMcpControls(session, { ...grant });
			return commit(prepared);
		});
		try {
			await expect(session.newSession()).resolves.toBe(true);
			expect(sessionManager.getSessionId()).not.toBe(originalId);
			expect(getExactMcpControls(session)).toBeUndefined();
			await expect(session.getExactMcpStatusSnapshot()).resolves.toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	for (const transition of ["fork", "branch"] as const) {
		test(`a grant attached at ${transition} adoption cannot authorize its successor`, async () => {
			const { session, sessionManager } = await exactSessionFixture(undefined, true);
			const grant = getExactMcpControls(session);
			if (!grant) throw new Error("Expected exact MCP controls");
			const entryId = sessionManager.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
			await sessionManager.flush();
			const originalFile = sessionManager.getSessionFile();
			revokeExactMcpControls(session);
			const commit = sessionManager.commitPreparedNewSession.bind(sessionManager);
			vi.spyOn(sessionManager, "commitPreparedNewSession").mockImplementation(prepared => {
				attachExactMcpControls(session, { ...grant });
				return commit(prepared);
			});
			try {
				if (transition === "fork") expect(await session.fork()).toBe(true);
				else expect((await session.branch(entryId)).cancelled).toBe(false);
				expect(sessionManager.getSessionFile()).not.toBe(originalFile);
				expect(getExactMcpControls(session)).toBeUndefined();
			} finally {
				await session.dispose();
			}
		});
	}

	for (const changesIdentity of [false, true]) {
		test(`throwing synchronous adoption ${changesIdentity ? "after" : "before"} identity change`, async () => {
			const { session, sessionManager } = await exactSessionFixture();
			const grant = getExactMcpControls(session);
			const originalId = sessionManager.getSessionId();
			const commit = sessionManager.commitPreparedNewSession.bind(sessionManager);
			vi.spyOn(sessionManager, "commitPreparedNewSession").mockImplementation(prepared => {
				if (changesIdentity) commit(prepared);
				throw new Error("injected adoption failure");
			});
			try {
				await expect(session.newSession()).rejects.toThrow("injected adoption failure");
				expect(sessionManager.getSessionId() === originalId).toBe(!changesIdentity);
				expect(getExactMcpControls(session)).toBe(changesIdentity ? undefined : grant);
			} finally {
				await session.dispose();
			}
		});
	}

	for (const mutation of ["unchanged", "revoked", "replaced"] as const) {
		test(`failed switch rollback does not resurrect ${mutation} predecessor authority`, async () => {
			const { session, sessionManager, manager, root } = await exactSessionFixture(undefined, true);
			const originalId = sessionManager.getSessionId();
			const originalFile = sessionManager.getSessionFile();
			const grant = getExactMcpControls(session);
			if (!grant) throw new Error("Expected exact MCP controls");
			const target = SessionManager.create(root, root);
			await target.ensureOnDisk();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected target file");
			const replacement = { ...grant };
			const reset = manager.prepareExactServerControlReset.bind(manager);
			vi.spyOn(manager, "prepareExactServerControlReset").mockImplementation(async () => {
				const prepared = await reset();
				if (mutation === "revoked") revokeExactMcpControls(session);
				if (mutation === "replaced") attachExactMcpControls(session, replacement);
				return { ...prepared, canCommit: () => false };
			});
			try {
				await expect(session.switchSession(targetFile)).rejects.toThrow(
					"Exact MCP control retirement changed before session switch commit",
				);
				expect(sessionManager.getSessionId()).toBe(originalId);
				expect(sessionManager.getSessionFile()).toBe(originalFile);
				expect(getExactMcpControls(session)).toBe(
					mutation === "unchanged" ? grant : mutation === "replaced" ? replacement : undefined,
				);
			} finally {
				await session.dispose();
				await target.close();
			}
		});
	}

	test("a grant attached during switch does not survive successor adoption", async () => {
		const { session, sessionManager, root } = await exactSessionFixture(undefined, true);
		const grant = getExactMcpControls(session);
		if (!grant) throw new Error("Expected exact MCP controls");
		const target = SessionManager.create(root, root);
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected target file");
		revokeExactMcpControls(session);
		const setSessionFile = sessionManager.setSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "setSessionFile").mockImplementation(async (...args) => {
			await setSessionFile(...args);
			attachExactMcpControls(session, { ...grant });
		});
		try {
			await expect(session.switchSession(targetFile)).resolves.toBe(true);
			expect(getExactMcpControls(session)).toBeUndefined();
			await expect(session.getExactMcpStatusSnapshot()).resolves.toBeUndefined();
		} finally {
			await session.dispose();
			await target.close();
		}
	});

	test("same-file reload retains authority while a copied-ID file switch retires it", async () => {
		const { session, sessionManager, root } = await exactSessionFixture(undefined, true);
		const originalId = sessionManager.getSessionId();
		const originalFile = sessionManager.getSessionFile();
		const grant = getExactMcpControls(session);
		if (!originalFile || !grant) throw new Error("Expected predecessor file and exact controls");
		const copiedFile = join(root, "copied.jsonl");
		await Bun.write(copiedFile, Bun.file(originalFile));
		try {
			await expect(session.switchSession(originalFile)).resolves.toBe(true);
			expect(getExactMcpControls(session)).toBe(grant);
			await expect(session.switchSession(copiedFile)).resolves.toBe(true);
			expect(sessionManager.getSessionId()).toBe(originalId);
			expect(sessionManager.getSessionFile()).toBe(copiedFile);
			expect(getExactMcpControls(session)).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("same-path reload retires authority when the loaded header identity changes", async () => {
		const { session, sessionManager, root } = await exactSessionFixture(undefined, true);
		const originalId = sessionManager.getSessionId();
		const originalFile = sessionManager.getSessionFile();
		if (!originalFile) throw new Error("Expected persisted predecessor");
		const target = SessionManager.create(root, root);
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected persisted successor");
		const targetId = target.getSessionId();
		expect(targetId).not.toBe(originalId);
		const setSessionFile = sessionManager.setSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "setSessionFile").mockImplementation(async (...args) => {
			await Bun.write(originalFile, Bun.file(targetFile));
			await setSessionFile(...args);
		});
		try {
			expect(await session.switchSession(originalFile)).toBe(true);
			expect(sessionManager.getSessionFile()).toBe(originalFile);
			expect(sessionManager.getSessionId()).toBe(targetId);
			expect(getExactMcpControls(session)).toBeUndefined();
			await expect(session.getExactMcpStatusSnapshot()).resolves.toBeUndefined();
			await expect(session.controlExactMcpServer("suspend", "exact")).resolves.toBeUndefined();
		} finally {
			await session.dispose();
			await target.close();
		}
	});

	test("failed retirement never resurrects an externally revoked predecessor grant", async () => {
		const { session, sessionManager, manager } = await exactSessionFixture();
		const originalId = sessionManager.getSessionId();
		const preparedStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reset = manager.prepareExactServerControlReset.bind(manager);
		vi.spyOn(manager, "prepareExactServerControlReset").mockImplementation(async () => {
			const prepared = await reset();
			preparedStarted.resolve();
			await release.promise;
			return { ...prepared, canCommit: () => false };
		});
		const transition = session.newSession();
		void transition.catch(() => {});
		try {
			await preparedStarted.promise;
			revokeExactMcpControls(session);
			release.resolve();
			await expect(transition).rejects.toThrow("Exact MCP control retirement changed before session adoption");
			expect(sessionManager.getSessionId()).toBe(originalId);
			expect(getExactMcpControls(session)).toBeUndefined();
		} finally {
			release.resolve();
			await Promise.allSettled([transition]);
			await session.dispose();
		}
	});

	test("manager replacement waits for an admitted exact control", async () => {
		const { session, manager } = await exactSessionFixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const prepare = manager.prepareExactServerControl.bind(manager);
		vi.spyOn(manager, "prepareExactServerControl").mockImplementation(async (action, name) => {
			const prepared = await prepare(action, name);
			started.resolve();
			await release.promise;
			return prepared;
		});
		const disconnect = vi.spyOn(manager, "disconnectAll");
		const control = session.controlExactMcpServer("suspend", "exact");
		await started.promise;
		const replacement = session.replaceOwnedMcpManager(undefined);
		try {
			await Promise.resolve();
			expect(disconnect).not.toHaveBeenCalled();
			release.resolve();
			await expect(control).resolves.toMatchObject({ status: "suspended" });
			await replacement;
			expect(disconnect).toHaveBeenCalledTimes(1);
		} finally {
			release.resolve();
			await Promise.allSettled([control, replacement]);
			await session.dispose();
		}
	});

	for (const operation of ["status", "control"] as const) {
		test(`replacement revokes an existing grant before queued ${operation} reaches the successor`, async () => {
			const { session, manager } = await exactSessionFixture();
			const successor = new MCPManager(tmpdir(), null, { toolsOnly: true });
			managers.push(successor);
			const successorNames = vi.spyOn(successor, "getAllServerNames");
			const successorControl = vi.spyOn(successor, "prepareExactServerControl");
			const disconnectStarted = Promise.withResolvers<void>();
			const releaseDisconnect = Promise.withResolvers<void>();
			const disconnect = manager.disconnectAll.bind(manager);
			vi.spyOn(manager, "disconnectAll").mockImplementation(async () => {
				disconnectStarted.resolve();
				await releaseDisconnect.promise;
				await disconnect();
			});
			const replacement = session.replaceOwnedMcpManager(successor);
			void replacement.catch(() => {});
			let queued: Promise<unknown> | undefined;
			try {
				await disconnectStarted.promise;
				expect(session.hasExactMcpControls).toBe(true);
				queued =
					operation === "status"
						? session.getExactMcpStatusSnapshot()
						: session.controlExactMcpServer("suspend", "exact");
				void queued.catch(() => {});
				releaseDisconnect.resolve();
				await replacement;
				await expect(queued).resolves.toBeUndefined();
				expect(session.hasExactMcpControls).toBe(false);
				await expect(session.getExactMcpStatusSnapshot()).resolves.toBeUndefined();
				await expect(session.controlExactMcpServer("suspend", "exact")).resolves.toBeUndefined();
				expect(successorNames).not.toHaveBeenCalled();
				expect(successorControl).not.toHaveBeenCalled();
			} finally {
				releaseDisconnect.resolve();
				await Promise.allSettled([replacement, ...(queued ? [queued] : [])]);
				await session.dispose();
			}
		});
	}

	test("replacement revokes predecessor and concurrently attached grants without blocking queued controls", async () => {
		const { session, manager } = await exactSessionFixture();
		const originalGrant = getExactMcpControls(session);
		if (!originalGrant) throw new Error("Expected exact MCP controls on the predecessor");
		const successor = new MCPManager(tmpdir(), null, { toolsOnly: true });
		managers.push(successor);
		const successorNames = vi.spyOn(successor, "getAllServerNames");
		const successorControl = vi.spyOn(successor, "prepareExactServerControl");
		const started = Promise.withResolvers<void>();
		const releaseControl = Promise.withResolvers<void>();
		const disconnectStarted = Promise.withResolvers<void>();
		const releaseDisconnect = Promise.withResolvers<void>();
		const prepare = manager.prepareExactServerControl.bind(manager);
		vi.spyOn(manager, "prepareExactServerControl").mockImplementation(async (action, name) => {
			const prepared = await prepare(action, name);
			started.resolve();
			await releaseControl.promise;
			return prepared;
		});
		const disconnect = manager.disconnectAll.bind(manager);
		vi.spyOn(manager, "disconnectAll").mockImplementation(async () => {
			disconnectStarted.resolve();
			await releaseDisconnect.promise;
			await disconnect();
		});
		const active = session.controlExactMcpServer("suspend", "exact");
		void active.catch(() => {});
		await started.promise;
		const replacement = session.replaceOwnedMcpManager(successor);
		void replacement.catch(() => {});
		const queuedPredecessor = session.getExactMcpStatusSnapshot();
		void queuedPredecessor.catch(() => {});
		let queuedAttachment: Promise<unknown> | undefined;
		try {
			releaseControl.resolve();
			await expect(active).resolves.toMatchObject({ status: "suspended" });
			await disconnectStarted.promise;
			expect(getExactMcpControls(session)).toBe(originalGrant);
			attachExactMcpControls(session, { ...originalGrant });
			queuedAttachment = session.controlExactMcpServer("suspend", "exact");
			void queuedAttachment.catch(() => {});
			releaseDisconnect.resolve();
			await replacement;
			await expect(queuedPredecessor).resolves.toBeUndefined();
			await expect(queuedAttachment).resolves.toBeUndefined();
			expect(getExactMcpControls(session)).toBeUndefined();
			await expect(session.getExactMcpStatusSnapshot()).resolves.toBeUndefined();
			await expect(session.controlExactMcpServer("suspend", "exact")).resolves.toBeUndefined();
			expect(successorNames).not.toHaveBeenCalled();
			expect(successorControl).not.toHaveBeenCalled();
		} finally {
			releaseControl.resolve();
			releaseDisconnect.resolve();
			await Promise.allSettled([
				active,
				replacement,
				queuedPredecessor,
				...(queuedAttachment ? [queuedAttachment] : []),
			]);
			await session.dispose();
		}
	});

	test("disposal disconnects a rejected owned replacement without disconnecting the current manager twice", async () => {
		const fixture = await exactSessionFixture();
		const { session, manager } = fixture;
		const grant = getExactMcpControls(session);
		if (!grant) throw new Error("Expected exact MCP controls");
		const candidateLive = connection("exact", []);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(candidateLive);
		const candidate = new MCPManager(tmpdir(), null, { toolsOnly: true });
		managers.push(candidate);
		await candidate.discoverAndConnect({ configPath: grant.configPath });
		const candidateDisconnect = vi.spyOn(candidate, "disconnectAll");
		const currentDisconnect = vi.spyOn(manager, "disconnectAll");
		const currentRelease = vi.spyOn(manager, "releaseLeases");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const prepare = manager.prepareExactServerControl.bind(manager);
		vi.spyOn(manager, "prepareExactServerControl").mockImplementation(async (action, name) => {
			const prepared = await prepare(action, name);
			started.resolve();
			await release.promise;
			return prepared;
		});
		const control = session.controlExactMcpServer("suspend", "exact");
		void control.catch(() => {});
		await started.promise;
		const replacement = session.replaceOwnedMcpManager(candidate);
		void replacement.catch(() => {});
		const sameManager = session.replaceOwnedMcpManager(manager);
		void sameManager.catch(() => {});
		try {
			const disposal = session.dispose();
			void disposal.catch(() => {});
			release.resolve();
			await expect(control).resolves.toMatchObject({ status: "suspended" });
			await expect(replacement).rejects.toThrow("Cannot replace the MCP manager after disposal has started.");
			await expect(sameManager).rejects.toThrow("Cannot replace the MCP manager after disposal has started.");
			await disposal;
			expect(currentDisconnect).toHaveBeenCalledTimes(1);
			expect(currentRelease).toHaveBeenCalledTimes(1);
			expect(candidateDisconnect).toHaveBeenCalledTimes(1);
			expect(candidateLive.transport.connected).toBe(false);
		} finally {
			release.resolve();
			await Promise.allSettled([control, replacement, sameManager, session.awaitDisposeCompletion()]);
		}
	});

	test("replacing a manager with itself preserves its exact grant", async () => {
		const { session, manager } = await exactSessionFixture();
		const grant = getExactMcpControls(session);
		const disconnect = vi.spyOn(manager, "disconnectAll");
		try {
			await session.replaceOwnedMcpManager(manager);
			expect(getExactMcpControls(session)).toBe(grant);
			expect(disconnect).not.toHaveBeenCalled();
			expect(await session.getExactMcpStatusSnapshot()).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	test("capability attachment is revocable and session-identity scoped", () => {
		const first = {} as AgentSession;
		const second = {} as AgentSession;
		attachExactMcpControls(first, {
			grantSource: "root-interactive-exact-config",
			configPath: "/tmp/first-mcp.json",
		});

		expect(getExactMcpControls(first)?.configPath).toBe("/tmp/first-mcp.json");
		expect(getExactMcpControls(second)).toBeUndefined();
		revokeExactMcpControls(first);
		expect(getExactMcpControls(first)).toBeUndefined();
	});

	test("suspend blocks stale wrappers locally and resume republishes working tools", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-exact-mcp-control-"));
		roots.push(root);
		const configPath = join(root, "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { exact: { type: "http", url: "http://127.0.0.1:1" } } }),
		);
		const calls: string[] = [];
		const live = connection("exact", calls);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(live);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "lookup", inputSchema: { type: "object" } }]);
		const manager = new MCPManager(root, null, { toolsOnly: true });
		managers.push(manager);
		await manager.discoverAndConnect({ configPath });
		const staleTool = manager.getTools()[0];
		expect(staleTool).toBeDefined();

		const suspension = await manager.prepareExactServerControl("suspend", "exact");
		expect(suspension.result.status).toBe("suspended");
		expect(suspension.tools).toHaveLength(0);
		await suspension.commit();
		expect(manager.isExactServerSuppressed("exact")).toBe(true);

		const staleResult = await staleTool!.execute("stale", {}, () => {}, {} as never);
		expect(staleResult.details?.isError).toBe(true);
		expect(calls).toEqual([]);

		const resumption = await manager.prepareExactServerControl("resume", "exact");
		expect(resumption.result.status).toBe("resumed");
		expect(resumption.tools).toHaveLength(1);
		await resumption.commit();
		expect(manager.isExactServerSuppressed("exact")).toBe(false);

		const freshTool = manager.getTools()[0];
		const freshResult = await freshTool!.execute("fresh", {}, () => {}, {} as never);
		expect(freshResult.details?.isError).toBeFalsy();
		expect(calls).toEqual(["tools/call"]);
	});

	test("an invalidated MCP tool does not replay after reconnect", async () => {
		const firstCallStarted = Promise.withResolvers<void>();
		const failFirstCall = Promise.withResolvers<void>();
		const reconnectStarted = Promise.withResolvers<void>();
		const finishReconnect = Promise.withResolvers<void>();
		const first = connection("exact", []);
		first.transport.request = (async () => {
			firstCallStarted.resolve();
			await failFirstCall.promise;
			throw new Error("ECONNRESET");
		}) as MCPTransport["request"];
		const replacementCalls: string[] = [];
		const replacement = connection("exact", replacementCalls);
		const tool = new MCPTool(first, { name: "lookup", inputSchema: { type: "object" } }, async () => {
			reconnectStarted.resolve();
			await finishReconnect.promise;
			return replacement;
		});

		const execution = tool.execute("race", {}, () => {}, {} as never);
		await firstCallStarted.promise;
		failFirstCall.resolve();
		await reconnectStarted.promise;
		tool.invalidateForSessionControl();
		finishReconnect.resolve();

		const result = await execution;
		expect(result.details?.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "MCP error: MCP server is suspended for this session" }]);
		expect(replacementCalls).toEqual([]);
	});

	test("an invalidated deferred MCP tool does not replay after reconnect", async () => {
		const firstCallStarted = Promise.withResolvers<void>();
		const failFirstCall = Promise.withResolvers<void>();
		const reconnectStarted = Promise.withResolvers<void>();
		const finishReconnect = Promise.withResolvers<void>();
		const first = connection("exact", []);
		first.transport.request = (async () => {
			firstCallStarted.resolve();
			await failFirstCall.promise;
			throw new Error("ECONNRESET");
		}) as MCPTransport["request"];
		const replacementCalls: string[] = [];
		const replacement = connection("exact", replacementCalls);
		const tool = new DeferredMCPTool(
			"exact",
			{ name: "lookup", inputSchema: { type: "object" } },
			async () => first,
			undefined,
			async () => {
				reconnectStarted.resolve();
				await finishReconnect.promise;
				return replacement;
			},
		);

		const execution = tool.execute("race", {}, () => {}, {} as never);
		await firstCallStarted.promise;
		failFirstCall.resolve();
		await reconnectStarted.promise;
		tool.invalidateForSessionControl();
		finishReconnect.resolve();

		const result = await execution;
		expect(result.details?.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "MCP error: MCP server is suspended for this session" }]);
		expect(replacementCalls).toEqual([]);
	});

	test("an unavailable reconnect preserves the published predecessor", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-exact-mcp-reconnect-"));
		roots.push(root);
		const configPath = join(root, "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { exact: { type: "http", url: "http://127.0.0.1:1" } } }),
		);
		const live = connection("exact", []);
		const connect = vi.spyOn(mcpClient, "connectToServer").mockResolvedValueOnce(live);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "lookup", inputSchema: { type: "object" } }]);
		const manager = new MCPManager(root, null, { toolsOnly: true });
		managers.push(manager);
		await manager.discoverAndConnect({ configPath });
		expect(manager.getTools()).toHaveLength(1);
		connect.mockRejectedValueOnce(new Error("replacement refused"));

		const reconnect = await manager.prepareExactServerControl("reconnect", "exact");
		expect(reconnect.result.status).toBe("unavailable");
		await reconnect.abort();
		expect(manager.getConnectionStatus("exact")).toBe("connected");
		expect(manager.getTools()).toHaveLength(1);
		expect(live.transport.connected).toBe(true);
	});

	test("startup catalog publication fences a committed suspension", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-exact-mcp-startup-fence-"));
		roots.push(root);
		const configPath = join(root, "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { exact: { type: "http", url: "http://127.0.0.1:1" } } }),
		);
		const listStarted = Promise.withResolvers<void>();
		const allowList = Promise.withResolvers<void>();
		const pool = new MCPConnectionPool({ connect: async (name, _config) => connection(name, []) });
		const manager = new MCPManager(root, null, { toolsOnly: true, pool });
		managers.push(manager);
		vi.spyOn(mcpClient, "listTools").mockImplementation(async () => {
			listStarted.resolve();
			await allowList.promise;
			return [{ name: "lookup", inputSchema: { type: "object" } }];
		});

		const startup = manager.discoverAndConnect({ configPath });
		await listStarted.promise;
		const suspension = await manager.prepareExactServerControl("suspend", "exact");
		await suspension.commit();
		allowList.resolve();

		const result = await startup;
		expect(result.tools).toHaveLength(0);
		expect(manager.getTools()).toHaveLength(0);
	});

	test("catalog snapshots distinguish an unpublished catalog from a fenced empty publication", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-exact-mcp-catalog-snapshot-"));
		roots.push(root);
		const configPath = join(root, "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({ mcpServers: { exact: { type: "http", url: "http://127.0.0.1:1" } } }),
		);
		const live = connection("exact", []);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(live);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([{ name: "lookup", inputSchema: { type: "object" } }]);
		const manager = new MCPManager(root, null, { toolsOnly: true });
		managers.push(manager);

		expect(manager.getToolCatalogSnapshot()).toMatchObject({ publication: "unpublished", generation: 0, tools: [] });
		await manager.discoverAndConnect({ configPath });
		const published = manager.getToolCatalogSnapshot();
		expect(published.publication).toBe("published");
		expect(published.generation).toBeGreaterThan(0);
		expect(published.tools).toHaveLength(1);

		const suspension = await manager.prepareExactServerControl("suspend", "exact");
		expect(manager.getToolCatalogSnapshot()).toMatchObject({
			publication: "fenced",
			generation: published.generation,
			tools: [],
		});
		await suspension.commit();
		expect(manager.getToolCatalogSnapshot()).toMatchObject({
			publication: "fenced",
			generation: published.generation,
			tools: [],
		});
	});

	test("prepared resume aborts a duplicate tool catalog instead of overwriting it", async () => {
		const root = await mkdtemp(join(tmpdir(), "gjc-exact-mcp-duplicate-"));
		roots.push(root);
		const configPath = join(root, "mcp.json");
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					stable: { type: "stdio", command: "stable" },
					target: { type: "stdio", command: "target" },
				},
			}),
		);
		const transports = new Map<string, MCPTransport>();
		const transportStates = new Map<string, { connected: boolean }>();
		const definitions = new Map<string, MCPToolDefinition[]>([
			["stable", [{ name: "collision", inputSchema: { type: "object" } }]],
			["target", [{ name: "target", inputSchema: { type: "object" } }]],
		]);
		const pool = new MCPConnectionPool({
			connect: async (name, config) => {
				const state = { connected: true };
				transportStates.set(name, state);
				const transport: MCPTransport = {
					get connected() {
						return state.connected;
					},
					request: async <T>() => ({}) as T,
					notify: async () => {},
					close: async () => {
						state.connected = false;
					},
				};
				transports.set(name, transport);
				return {
					...connection(name, []),
					config,
					transport,
				};
			},
		});
		const manager = new MCPManager(root, null, { toolsOnly: true, pool });
		managers.push(manager);
		vi.spyOn(mcpClient, "listTools").mockImplementation(async server => definitions.get(server.name) ?? []);

		await manager.discoverAndConnect({ configPath });
		const suspension = await manager.prepareExactServerControl("suspend", "target");
		await suspension.commit();
		const targetState = transportStates.get("target");
		if (!targetState) throw new Error("target transport was not opened");
		targetState.connected = false;
		definitions.set("target", [
			{ name: "collision", inputSchema: { type: "object" } },
			{ name: "collision", inputSchema: { type: "object" } },
		]);

		const resumed = await manager.prepareExactServerControl("resume", "target");
		expect(resumed.result.status).toBe("unavailable");
		expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__stable_collision"]);
		expect(transports.get("target")?.connected).toBe(false);
	});
});
