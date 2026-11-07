import { afterEach, expect, test, vi } from "bun:test";
import * as nativeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import * as codexProvider from "@gajae-code/ai/providers/openai-codex-responses";
import * as native from "@gajae-code/natives";
import { AsyncJobManager } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/sdk/session";
import { SessionFamilyOwnership, SessionFamilyOwnershipError } from "../src/sdk/session-family-ownership";
import { SessionFamilyRegistry } from "../src/sdk/session-family-registry";
import {
	cancelPreparedFamilySession,
	getSessionFamilyStartup,
	prepareNewFamilySession,
} from "../src/sdk/session-family-startup";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const cleanups: Array<() => Promise<void>> = [];
async function fixture() {
	const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-family-startup-"));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "profile");
	const authority = path.join(root, "authority");
	await fs.mkdir(cwd);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	const mock = createMockModel();
	auth.setRuntimeApiKey(mock.model.provider, "fixture-key");
	const registry = new AgentRegistry();
	const priorJobs = AsyncJobManager.instance();
	const sessions: AgentSession[] = [];
	cleanups.push(async () => {
		try {
			for (const session of sessions) await session.awaitDisposeCompletion();
		} finally {
			AsyncJobManager.setInstance(priorJobs);
			auth.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	const options: CreateAgentSessionOptions = {
		cwd,
		agentDir,
		authStorage: auth,
		modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
		model: mock.model,
		settings: Settings.isolated(),
		agentId: `family-fixture-${crypto.randomUUID()}`,
		agentRegistry: registry,
		disableExtensionDiscovery: true,
		extensions: [],
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
	};
	return {
		root,
		cwd,
		agentDir,
		authority,
		options,
		registry,
		sessions,
		ownership: new SessionFamilyOwnership(authority),
	};
}

afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});

const requiredNativeMethods: ReadonlyArray<readonly [string, object, readonly string[]]> = [
	["NativeStagedDirectory", native.NativeStagedDirectory.prototype, ["syncSync", "createOwnedChild"]],
	[
		"NativeOwnedStagedDirectory",
		native.NativeOwnedStagedDirectory.prototype,
		["creationReceipt", "bindFile", "syncSync", "retireEmptySync", "release"],
	],
	[
		"NativeOwnedStagedFile",
		native.NativeOwnedStagedFile.prototype,
		["moveNoReplaceSync", "sealSync", "discardSync", "release"],
	],
];
for (const [name, prototype, methods] of requiredNativeMethods) {
	for (const method of methods) {
		test(`missing retained cleanup capability ${name}.${method} rejects admission before authority or private writes`, async () => {
			const env = await fixture();
			const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
			if (!descriptor) throw new Error(`Native fixture method ${name}.${method} is unavailable`);
			try {
				Object.defineProperty(prototype, method, { ...descriptor, value: undefined });
				await expect(prepareNewFamilySession(env.options, env.authority)).rejects.toMatchObject({
					code: "unsupported",
				});
				await expect(fs.lstat(env.authority)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(fs.lstat(env.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				Object.defineProperty(prototype, method, descriptor);
			}
		});
	}
}

test("prepared startup registers its reserved identity and blocks losers before private initialization", async () => {
	const env = await fixture();
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	const loserDir = path.join(env.root, "loser-profile");
	await expect(prepareNewFamilySession({ ...env.options, agentDir: loserDir }, env.authority)).rejects.toMatchObject({
		code: "busy_workspace",
	});
	await expect(fs.lstat(loserDir)).rejects.toMatchObject({ code: "ENOENT" });
	const result = await createAgentSession(prepared);
	env.sessions.push(result.session);
	const references = await new SessionFamilyRegistry(env.authority).listForWorkspace(env.cwd);
	expect(references).toHaveLength(1);
	const persisted = await fs.stat(references[0]!.sessionFile, { bigint: true });
	expect(references[0]).toMatchObject({ device: persisted.dev.toString(), inode: persisted.ino.toString() });
	expect(references[0]).toMatchObject({
		branchId: result.session.sessionId,
		familyId: result.session.sessionId,
		parentBranchId: null,
		anchor: null,
		storage: "managed",
	});
	await expect(createAgentSession(prepared)).rejects.toMatchObject({ code: "stale_reference" });
	await expect(cancelPreparedFamilySession(prepared)).rejects.toMatchObject({ code: "stale_reference" });
	await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "busy_workspace" });
	await result.session.awaitDisposeCompletion();
	const successor = await env.ownership.acquireRoot(env.cwd, result.session.sessionId);
	await env.ownership.releaseAfterTeardown(successor, async () => {});
});

test("clean owned rewrites refresh only the physical binding at release", async () => {
	const env = await fixture();
	const result = await createAgentSession(await prepareNewFamilySession(env.options, env.authority));
	env.sessions.push(result.session);
	const registry = new SessionFamilyRegistry(env.authority);
	const before = (await registry.listForWorkspace(env.cwd))[0]!;
	const manager = result.session.sessionManager;
	manager.appendMessage({ role: "user", content: "owned rewrite fixture", timestamp: Date.now() });
	await manager.rewriteEntries();
	const physical = await fs.stat(before.sessionFile, { bigint: true });
	expect(physical.ino.toString()).not.toBe(before.inode);
	expect((await registry.listForWorkspace(env.cwd))[0]).toEqual(before);
	await result.session.awaitDisposeCompletion();
	const after = (await registry.listForWorkspace(env.cwd))[0]!;
	expect(after).toEqual({ ...before, device: physical.dev.toString(), inode: physical.ino.toString() });
	expect(
		await registry.registerExisting({
			sessionFile: after.sessionFile,
			sourceDirectory: after.sourceDirectory,
			expectedSessionId: after.branchId,
			expectedCwd: env.cwd,
			storage: "managed",
			managedAgentDir: env.agentDir,
		}),
	).toEqual(after);
	const successor = await env.ownership.acquireRoot(env.cwd, after.branchId);
	await env.ownership.releaseAfterTeardown(successor, async () => {});
});

test("a foreign replacement is never adopted as the owner's final transcript", async () => {
	const env = await fixture();
	const result = await createAgentSession(await prepareNewFamilySession(env.options, env.authority));
	const registry = new SessionFamilyRegistry(env.authority);
	const before = (await registry.listForWorkspace(env.cwd))[0]!;
	const replacement = path.join(env.root, "replacement.jsonl");
	await fs.copyFile(before.sessionFile, replacement);
	await fs.rename(replacement, before.sessionFile);
	try {
		await expect(result.session.awaitDisposeCompletion()).rejects.toThrow("Retained session disposal failed.");
		expect((await registry.listForWorkspace(env.cwd))[0]).toEqual(before);
		await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "uncertain" });
	} finally {
		await result.session.awaitDisposeCompletion().catch(() => {});
	}
});

test("a structurally copied terminal proof cannot release ownership", async () => {
	const env = await fixture();
	const grant = await env.ownership.acquireRoot(env.cwd);
	const manager = SessionManager.create(env.cwd, SessionManager.managedDestination(env.cwd, env.agentDir), undefined, {
		sessionId: grant.sessionId,
	});
	try {
		await manager.ensureOnDisk();
		expect(await manager.closeStrict()).toEqual({ kind: "closed" });
		const proof = manager.captureClosedManagedTranscriptProof();
		try {
			await expect(
				env.ownership.releaseAfterTeardown(
					grant,
					async () => {},
					() => ({ ...proof }),
				),
			).rejects.toMatchObject({
				code: "uncertain",
			});
			expect(proof.revalidate()).toEqual({ kind: "valid" });
			await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "uncertain" });
		} finally {
			proof.close();
		}
	} finally {
		await manager.closeStrict();
	}
});

test("read-proof close failure cannot publish a replacement or release ownership", async () => {
	const env = await fixture();
	const grant = await env.ownership.acquireRoot(env.cwd);
	const manager = SessionManager.create(env.cwd, SessionManager.managedDestination(env.cwd, env.agentDir), undefined, {
		sessionId: grant.sessionId,
	});
	let blockedDescriptor: number | undefined;
	const closeDescriptor = nativeFs.closeSync;
	try {
		await manager.ensureOnDisk();
		const registry = new SessionFamilyRegistry(env.authority);
		const before = await registry.registerExisting({
			sessionFile: manager.getSessionFile()!,
			sourceDirectory: manager.getSessionDir(),
			expectedSessionId: grant.sessionId,
			expectedCwd: env.cwd,
			storage: "managed",
			managedAgentDir: env.agentDir,
		});
		manager.appendMessage({ role: "user", content: "owned replacement", timestamp: Date.now() });
		await manager.rewriteEntries();
		expect(await manager.closeStrict()).toEqual({ kind: "closed" });
		const proof = manager.captureClosedManagedTranscriptProof();
		expect(proof.identity.ino.toString()).not.toBe(before.inode);
		const close = vi.spyOn(nativeFs, "closeSync").mockImplementation(descriptor => {
			const stat = nativeFs.fstatSync(descriptor, { bigint: true });
			if (stat.dev === proof.identity.dev && stat.ino === proof.identity.ino) {
				blockedDescriptor = descriptor;
				throw new Error("controlled read descriptor close failure");
			}
			closeDescriptor(descriptor);
		});
		try {
			await expect(
				env.ownership.releaseAfterTeardown(
					grant,
					async () => {},
					() => proof,
				),
			).rejects.toMatchObject({
				code: "uncertain",
				cause: { message: "controlled read descriptor close failure" },
			});
			expect(blockedDescriptor).toBeDefined();
			expect((await registry.listForWorkspace(env.cwd))[0]).toEqual(before);
			await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "uncertain" });
		} finally {
			close.mockRestore();
			proof.close();
		}
	} finally {
		// This fixture intercepted close before OS dispatch, so its descriptor is still owned.
		if (blockedDescriptor !== undefined) closeDescriptor(blockedDescriptor);
		await manager.closeStrict();
	}
	await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "uncertain" });
});

test("unstarted reservations can be cancelled without creating private session state", async () => {
	const env = await fixture();
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	await cancelPreparedFamilySession(prepared);
	await expect(fs.lstat(env.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(createAgentSession(prepared)).rejects.toMatchObject({ code: "stale_reference" });
	const successor = await env.ownership.acquireRoot(env.cwd);
	await env.ownership.releaseAfterTeardown(successor, async () => {});
});

test("workspace replacement refuses startup before creating private state", async () => {
	const env = await fixture();
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	await fs.rename(env.cwd, path.join(env.root, "original-workspace"));
	await fs.mkdir(env.cwd);
	await expect(createAgentSession(prepared)).rejects.toMatchObject({ code: "identity_conflict" });
	await expect(fs.lstat(env.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	const successor = await env.ownership.acquireRoot(env.cwd);
	await env.ownership.releaseAfterTeardown(successor, async () => {});
});

test("side-effect-free SDK validation failure releases only its unstarted allocation", async () => {
	const env = await fixture();
	const prepared = await prepareNewFamilySession({ ...env.options, mcpConfigPath: "relative.json" }, env.authority);
	await expect(createAgentSession(prepared)).rejects.toThrow("absolute");
	await expect(fs.lstat(env.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
	const successor = await env.ownership.acquireRoot(env.cwd);
	await env.ownership.releaseAfterTeardown(successor, async () => {});
});

test.each([
	"profile",
	"attachment",
] as const)("post-construction %s failure rejects readiness before joining retained disposal", async point => {
	const env = await fixture();
	let constructed: AgentSession | undefined;
	const disposal = vi.spyOn(AgentSession.prototype, "dispose");
	const fail = (session: AgentSession): never => {
		constructed = session;
		throw new Error("controlled family startup failure");
	};
	if (point === "profile") {
		vi.spyOn(AgentSession.prototype, "setActiveModelProfile").mockImplementation(function (this: AgentSession) {
			fail(this);
		});
	} else {
		vi.spyOn(env.registry, "attachSession").mockImplementation((_id, session) => {
			fail(session);
		});
	}
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	try {
		await expect(createAgentSession(prepared)).rejects.toThrow("controlled family startup failure");
		expect(constructed).toBeDefined();
		expect(disposal).toHaveBeenCalledTimes(1);
		await expect(constructed!.awaitDisposeCompletion()).rejects.toThrow("Retained session disposal failed.");
		expect(await constructed!.sessionManager.closeStrict()).toEqual({ kind: "closed" });
		expect(env.registry.get(env.options.agentId!)).toBeUndefined();
		await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "uncertain" });
	} finally {
		await constructed?.awaitDisposeCompletion().catch(() => {});
	}
});

test("a runtime disposed during startup is never published as ready", async () => {
	const env = await fixture();
	let constructed: AgentSession | undefined;
	vi.spyOn(env.registry, "attachSession").mockImplementation((_id, session) => {
		constructed = session;
		void session.dispose().catch(() => {});
	});
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	try {
		const outcome = await createAgentSession(prepared).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(outcome).toBeInstanceOf(Error);
		expect(constructed?.isDisposed).toBe(true);
		await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "uncertain" });
		await expect(constructed!.awaitDisposeCompletion()).rejects.toThrow("Retained session disposal failed.");
	} finally {
		await constructed?.awaitDisposeCompletion().catch(() => {});
	}
});

test("a pre-construction failure closes the admitted writer but retains uncertainty", async () => {
	const env = await fixture();
	let manager: SessionManager | undefined;
	const close = vi.spyOn(SessionManager.prototype, "closeStrict");
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	vi.spyOn(getSessionFamilyStartup(prepared)!, "acceptManager").mockImplementation(candidate => {
		manager = candidate;
		candidate.appendMessage({ role: "user", content: "admitted startup fixture", timestamp: Date.now() });
		throw new Error("controlled registration failure");
	});
	await expect(createAgentSession(prepared)).rejects.toThrow("controlled registration failure");
	expect(manager).toBeDefined();
	expect(close).toHaveBeenCalledTimes(1);
	expect(await manager!.closeStrict()).toEqual({ kind: "closed" });
	await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "uncertain" });
});

test("startup failure becomes durably uncertain while physical writer cleanup is pending", async () => {
	const env = await fixture();
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const close = SessionManager.prototype.closeStrict;
	vi.spyOn(SessionManager.prototype, "closeStrict").mockImplementation(async function (this: SessionManager) {
		entered.resolve();
		await gate.promise;
		return close.call(this);
	});
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	vi.spyOn(getSessionFamilyStartup(prepared)!, "acceptManager").mockImplementation(() => {
		throw new Error("controlled startup failure before writer cleanup");
	});
	let settled = false;
	const creation = createAgentSession(prepared);
	void creation.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	try {
		await entered.promise;
		let code: string | undefined;
		const deadline = Date.now() + 5_000;
		do {
			try {
				const unexpected = await env.ownership.acquireRoot(env.cwd);
				await env.ownership.releaseAfterTeardown(unexpected, async () => {});
				throw new Error("Failed startup unexpectedly released ownership");
			} catch (error) {
				if (!(error instanceof SessionFamilyOwnershipError)) throw error;
				code = error.code;
			}
			if (code !== "uncertain") await Bun.sleep(10);
		} while (code !== "uncertain" && Date.now() < deadline);
		expect(code).toBe("uncertain");
		expect(settled).toBe(false);
		gate.resolve();
		await expect(creation).rejects.toThrow("controlled startup failure before writer cleanup");
	} finally {
		gate.resolve();
		await creation.catch(() => {});
	}
});

test.each([
	"flush",
	"registry",
] as const)("retirement during %s preparation cannot publish a reference", async point => {
	const env = await fixture();
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let constructed: AgentSession | undefined;
	const attach = env.registry.attachSession.bind(env.registry);
	vi.spyOn(env.registry, "attachSession").mockImplementation((id, session) => {
		constructed = session;
		attach(id, session);
	});
	const originalRegistration = SessionFamilyRegistry.prototype.registerExisting;
	const publication = vi.spyOn(SessionFamilyRegistry.prototype, "registerExisting").mockImplementation(async function (
		this: SessionFamilyRegistry,
		input,
		canPublish,
	) {
		if (point === "registry") {
			entered.resolve();
			await gate.promise;
		}
		return originalRegistration.call(this, input, canPublish);
	});
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	const startup = getSessionFamilyStartup(prepared)!;
	const registerManager = startup.registerManager.bind(startup);
	vi.spyOn(startup, "registerManager").mockImplementation(async (manager, agentDir, isDisposed) => {
		if (point === "flush") {
			const flush = manager.flush.bind(manager);
			vi.spyOn(manager, "flush").mockImplementation(async () => {
				await flush();
				entered.resolve();
				await gate.promise;
			});
		}
		await registerManager(manager, agentDir, isDisposed);
	});
	const creation = createAgentSession(prepared);
	void creation.catch(() => {});
	try {
		await entered.promise;
		expect(constructed).toBeDefined();
		const disposal = constructed!.awaitDisposeCompletion();
		void disposal.catch(() => {});
		gate.resolve();
		await expect(creation).rejects.toBeInstanceOf(Error);
		await expect(disposal).rejects.toThrow("Retained session disposal failed.");
		expect(publication).toHaveBeenCalledTimes(point === "registry" ? 1 : 0);
		expect(await new SessionFamilyRegistry(env.authority).listForWorkspace(env.cwd)).toEqual([]);
		await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "uncertain" });
	} finally {
		gate.resolve();
		await creation.catch(() => {});
		await constructed?.awaitDisposeCompletion().catch(() => {});
	}
});

test.each(["settled", "failed"] as const)("detached provider prewarm retains admission until %s", async outcome => {
	const env = await fixture();
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const cleanupEntered = Promise.withResolvers<void>();
	env.options.model = { ...env.options.model!, api: "openai-codex-responses", provider: "openai-codex" };
	vi.spyOn(env.options.modelRegistry!, "getApiKey").mockResolvedValue("synthetic-prewarm-fixture");
	vi.spyOn(codexProvider, "getOpenAICodexTransportDetails").mockReturnValue({
		websocketPreferred: true,
		websocketDisabled: false,
		websocketConnected: false,
		fallbackCount: 0,
		canAppend: false,
		prewarmed: false,
		hasSessionState: false,
	});
	vi.spyOn(codexProvider, "prewarmOpenAICodexResponses").mockImplementation(() => {
		entered.resolve();
		return gate.promise;
	});
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	const result = await createAgentSession(prepared);
	await entered.promise;
	result.session.registerToolSessionCleanup(() => {
		cleanupEntered.resolve();
	});
	let disposed = false;
	const completion = result.session.awaitDisposeCompletion();
	void completion.then(
		() => {
			disposed = true;
		},
		() => {
			disposed = true;
		},
	);
	try {
		await cleanupEntered.promise;
		await Bun.sleep(50);
		expect(disposed).toBe(false);
		await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "busy_workspace" });
		if (outcome === "failed") {
			gate.reject(new Error("controlled prewarm failure"));
			await expect(completion).rejects.toThrow("Retained session disposal failed.");
			await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "uncertain" });
		} else {
			gate.resolve();
			await completion;
			const successor = await env.ownership.acquireRoot(env.cwd);
			await env.ownership.releaseAfterTeardown(successor, async () => {});
		}
	} finally {
		gate.resolve();
		await completion.catch(() => {});
	}
});

test("ordinary SDK creation remains outside family admission when the internal handoff is omitted", async () => {
	const env = await fixture();
	const prepared = await prepareNewFamilySession(env.options, env.authority);
	const result = await createAgentSession(env.options);
	env.sessions.push(result.session);
	await result.session.awaitDisposeCompletion();
	await expect(env.ownership.acquireRoot(env.cwd)).rejects.toMatchObject({ code: "busy_workspace" });
	await cancelPreparedFamilySession(prepared);
});

test("an injected existing manager cannot synthesize startup authority", async () => {
	const env = await fixture();
	const manager = SessionManager.inMemory(env.cwd);
	try {
		await expect(
			prepareNewFamilySession({ ...env.options, sessionManager: manager }, env.authority),
		).rejects.toMatchObject({ code: "unsupported" });
		await expect(fs.lstat(env.authority)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await manager.closeStrict();
	}
});
