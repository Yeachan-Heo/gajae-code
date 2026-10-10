import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@gajae-code/ai/core";
import { getBundledModel } from "@gajae-code/ai/models";
import type { Message, ProviderSessionState } from "@gajae-code/ai/types";
import { Snowflake } from "@gajae-code/utils";
import { stablePathKey } from "@gajae-code/utils/path-identity";
import { AsyncJobManager } from "../src/async";
import { asyncJobEndpointId } from "../src/async/endpoint-id";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import type { AgentSession, ForkContextSeed } from "../src/session/agent-session";
import { ArtifactManager } from "../src/session/artifacts";
import { AuthStorage } from "../src/session/auth-storage";
import { ManagedSessionDescendantStore, managedDirectoryRoot } from "../src/session/internal/managed-session-storage";
import { SessionManager } from "../src/session/session-manager";
import { createManagedTaskPersistence } from "../src/task/executor";

function createHandBuiltSeed(): ForkContextSeed {
	const message: Message = {
		role: "user",
		content: [{ type: "text", text: "seed" }],
		attribution: "user",
		timestamp: 1,
	};
	return {
		messages: [message],
		agentMessages: [message],
		metadata: {
			sourceSessionId: "parent-session-id",
			parentMessageCount: 1,
			includedMessages: 1,
			skippedMessages: 0,
			approximateTokens: 1,
			maxMessages: 50,
			maxTokens: 1_000,
			skippedReasons: {},
		},
	};
}

async function createSession(
	tempDir: string,
	options: {
		forkContextSeed?: ForkContextSeed;
		providerSessionId?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
		sessionManager?: SessionManager;
	} = {},
) {
	const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
	authStorage.setRuntimeApiKey("openai", "test-key");
	const model = getBundledModel("openai", "gpt-5-mini");
	if (!model) throw new Error("Expected bundled openai/gpt-5-mini model");
	const result = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		authStorage,
		sessionManager: options.sessionManager ?? SessionManager.create(tempDir, tempDir),
		model,
		settings: Settings.isolated(),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		deferOptionalModelRefresh: true,
		notificationHostModeSupported: false,
		sdkHostModeSupported: false,
		forkContextSeed: options.forkContextSeed,
		providerSessionId: options.providerSessionId,
		providerSessionState: options.providerSessionState,
	});
	return { session: result.session, authStorage };
}
async function withLifecycleIdentity<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
	const previousRequestId = process.env.GJC_LIFECYCLE_REQUEST_ID;
	const previousSessionId = process.env.GJC_SESSION_ID;
	try {
		process.env.GJC_LIFECYCLE_REQUEST_ID = "task-provider-identity-test";
		process.env.GJC_SESSION_ID = sessionId;
		return await run();
	} finally {
		if (previousRequestId === undefined) delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		else process.env.GJC_LIFECYCLE_REQUEST_ID = previousRequestId;
		if (previousSessionId === undefined) delete process.env.GJC_SESSION_ID;
		else process.env.GJC_SESSION_ID = previousSessionId;
	}
}

async function withoutLifecycleIdentity<T>(run: () => Promise<T>): Promise<T> {
	const previousRequestId = process.env.GJC_LIFECYCLE_REQUEST_ID;
	const previousSessionId = process.env.GJC_SESSION_ID;
	try {
		delete process.env.GJC_LIFECYCLE_REQUEST_ID;
		delete process.env.GJC_SESSION_ID;
		return await run();
	} finally {
		if (previousRequestId !== undefined) process.env.GJC_LIFECYCLE_REQUEST_ID = previousRequestId;
		if (previousSessionId !== undefined) process.env.GJC_SESSION_ID = previousSessionId;
	}
}

describe("async job endpoint id derivation", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir && fs.existsSync(tempDir)) await fsPromises.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the logical session id without an explicit provider scope", () => {
		expect(asyncJobEndpointId(undefined, "logical-id", "/tmp/anything.jsonl")).toBe("logical-id");
		expect(asyncJobEndpointId("provider", "logical-id", undefined)).toBe("logical-id");
	});

	it("keeps endpoint keys stable as a transcript is created and replaced", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-endpoint-persist-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const sessionFile = path.join(tempDir, "session.jsonl");
		const beforeCreate = asyncJobEndpointId("provider", "logical-id", sessionFile);

		await Bun.write(sessionFile, "first");
		expect(asyncJobEndpointId("provider", "logical-id", sessionFile)).toBe(beforeCreate);

		await fsPromises.rm(sessionFile);
		await Bun.write(sessionFile, "replacement");
		expect(asyncJobEndpointId("provider", "logical-id", sessionFile)).toBe(beforeCreate);
	});

	it("collapses symlink and dot-segment transcript aliases onto one endpoint key", async () => {
		if (process.platform === "win32") return;
		const tempDir = await fsPromises.realpath(
			await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-endpoint-alias-${Snowflake.next()}-`)),
		);
		tempDirs.push(tempDir);
		const realDir = path.join(tempDir, "real");
		await fsPromises.mkdir(realDir);
		const realFile = path.join(realDir, "session.jsonl");
		await Bun.write(realFile, "");
		await fsPromises.symlink(realDir, path.join(tempDir, "alias-dir"), "dir");
		await fsPromises.symlink(realFile, path.join(tempDir, "alias-file.jsonl"));

		const canonical = asyncJobEndpointId("provider", "logical-id", realFile);
		expect(canonical).toBe(JSON.stringify(["async-job-endpoint", "provider", realFile]));
		// Directory-symlink alias, file-symlink alias, and a dot-segment path all
		// designate the same transcript, so all must key the same manager.
		expect(asyncJobEndpointId("provider", "logical-id", path.join(tempDir, "alias-dir", "session.jsonl"))).toBe(
			canonical,
		);
		expect(asyncJobEndpointId("provider", "logical-id", path.join(tempDir, "alias-file.jsonl"))).toBe(canonical);
		expect(asyncJobEndpointId("provider", "logical-id", path.join(realDir, "..", "real", "session.jsonl"))).toBe(
			canonical,
		);
	});

	it("keeps distinct transcripts and distinct provider scopes on distinct keys", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-endpoint-distinct-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const first = path.join(tempDir, "a.jsonl");
		const second = path.join(tempDir, "b.jsonl");
		expect(asyncJobEndpointId("provider", "logical-id", first)).not.toBe(
			asyncJobEndpointId("provider", "logical-id", second),
		);
		expect(asyncJobEndpointId("provider-a", "logical-id", first)).not.toBe(
			asyncJobEndpointId("provider-b", "logical-id", first),
		);
	});

	it("keys Windows path aliases stably without merging case-sensitive files", async () => {
		if (process.platform !== "win32") return;

		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-endpoint-case-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const sessionFile1 = path.join(tempDir, "Session.jsonl");
		const sessionFile2 = path.join(tempDir, "session.jsonl");
		await Bun.write(sessionFile1, "first");
		const endpoint1 = asyncJobEndpointId("provider", "logical-id", sessionFile1);

		await Bun.write(sessionFile2, "second");
		const distinctCaseSensitiveFiles = (await Bun.file(sessionFile1).text()) === "first";

		const endpoint2 = asyncJobEndpointId("provider", "logical-id", sessionFile2);

		// Case-insensitive Windows directories resolve aliases to the recorded
		// entry spelling; case-sensitive directories allow distinct files and keys.
		expect(endpoint1 === endpoint2).toBe(!distinctCaseSensitiveFiles);
	});
});

describe("task fork-context provider identity", () => {
	const sessions: AgentSession[] = [];
	const authStorages: AuthStorage[] = [];
	const artifactStores: ManagedSessionDescendantStore[] = [];
	const tempDirs: string[] = [];
	async function listTempTree(dir: string, prefix = ""): Promise<string[]> {
		const entries = await fsPromises.readdir(dir, { withFileTypes: true });
		const paths: string[] = [];
		for (const entry of entries) {
			const relativePath = path.join(prefix, entry.name);
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				paths.push(`${relativePath}/`, ...(await listTempTree(path.join(dir, entry.name), relativePath)));
			} else {
				paths.push(relativePath);
			}
		}
		return paths;
	}
	async function removeTempTree(dir: string): Promise<void> {
		// Retry recursive removal with backoff in case lock directories are still being cleaned up
		let lastError: unknown;
		for (let attempts = 0; attempts < 10; attempts++) {
			try {
				await fsPromises.rm(dir, { recursive: true, force: true });
				return;
			} catch (error) {
				lastError = error;
				if (attempts < 9) {
					await Bun.sleep(10 * (attempts + 1));
				}
			}
		}
		throw new Error(`Failed to remove directory ${dir}`, { cause: lastError });
	}

	afterEach(async () => {
		// Ensure all sessions are properly disposed and no writes are pending after disposal
		while (sessions.length > 0) await sessions.pop()?.dispose();
		while (authStorages.length > 0) authStorages.pop()?.close();
		while (artifactStores.length > 0) artifactStores.pop()?.close();
		
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (!tempDir) continue;
			const modelCacheClosed = closeModelCache(path.join(tempDir, "models.db"));
			if (!fs.existsSync(tempDir)) continue;
			try {
				await removeTempTree(tempDir);
			} catch (error) {
				let remaining: string[];
				try {
					remaining = await listTempTree(tempDir);
				} catch {
					remaining = ["<unreadable>"];
				}
				const failure = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to remove ${tempDir}; failure=${failure}; cwd=${process.cwd()}; modelCacheClosed=${modelCacheClosed}; remaining=${JSON.stringify(remaining)}`,
					{ cause: error },
				);
			}
		}
	}, 15_000);

	it("canonicalizes an existing root alias before creating a missing managed descendant", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-managed-root-alias-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const configuredRoot = path.join(tempDir, "managed-root");
		await fsPromises.mkdir(configuredRoot);
		const root = managedDirectoryRoot(configuredRoot);
		const rootAlias = path.join(tempDir, "managed-root-alias");
		await fsPromises.symlink(configuredRoot, rootAlias, process.platform === "win32" ? "junction" : "dir");

		const store = new ManagedSessionDescendantStore(root, path.join(rootAlias, "artifacts"));
		try {
			expect(store.dir).toBe(path.join(root.canonicalPath, "artifacts"));
		} finally {
			store.close();
		}
	});

	it("rejects a managed child replaced with a sibling-scope symlink", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-managed-child-symlink-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const root = managedDirectoryRoot(tempDir);
		const siblingPath = path.join(root.canonicalPath, "sibling-scope");
		const preparedPath = path.join(root.canonicalPath, "prepared-scope");
		await fsPromises.mkdir(siblingPath, { mode: 0o700 });
		await fsPromises.mkdir(preparedPath, { mode: 0o700 });
		await fsPromises.rmdir(preparedPath);
		await fsPromises.symlink(siblingPath, preparedPath, process.platform === "win32" ? "junction" : "dir");

		expect(() => new ManagedSessionDescendantStore(root, preparedPath)).toThrow(/symlink/i);
	});

	it("canonicalizes a retained authority base before deriving a descendant path", async () => {
		if (process.platform !== "linux") return;

		const tempDir = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), `pi-managed-retained-alias-${Snowflake.next()}-`),
		);
		tempDirs.push(tempDir);
		const configuredRoot = path.join(tempDir, "managed-root");
		await fsPromises.mkdir(configuredRoot, { mode: 0o700 });
		const root = managedDirectoryRoot(configuredRoot);
		const rootAlias = path.join(tempDir, "managed-root-alias");
		await fsPromises.symlink(configuredRoot, rootAlias, "dir");
		const artifactsDir = path.join(root.canonicalPath, "artifacts");
		await fsPromises.mkdir(artifactsDir, { mode: 0o700 });

		const parentStore = new ManagedSessionDescendantStore(root, root.canonicalPath);
		const retainedAuthority = parentStore.retainAuthority();
		if (!retainedAuthority) throw new Error("Expected the Linux managed store to retain its authority");
		try {
			const childStore = new ManagedSessionDescendantStore(root, path.join(rootAlias, "artifacts"), {
				authority: retainedAuthority,
				authorityBaseDir: rootAlias,
			});
			try {
				expect(childStore.dir).toBe(artifactsDir);
			} finally {
				childStore.close();
			}
		} finally {
			retainedAuthority.close();
			parentStore.close();
		}
	});

	it("gives nested managed children distinct provider identities without rewriting logical headers", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-task-cache-key-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const { session: parent, authStorage: parentAuth } = await createSession(tempDir);
		sessions.push(parent);
		authStorages.push(parentAuth);
		parent.agent.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });
		const seedA = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		const seedB = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		expect(seedA.metadata.includedMessages).toBeGreaterThan(0);

		const root = managedDirectoryRoot(tempDir);
		const artifactsDir = path.join(root.canonicalPath, "artifacts");
		const artifactStore = new ManagedSessionDescendantStore(root, artifactsDir);
		artifactStores.push(artifactStore);
		const artifacts = new ArtifactManager(artifactStore);
		const childAProviderSessionId = JSON.stringify(["subagent-canonical", parent.sessionId, "0-child-a"]);
		const childBProviderSessionId = JSON.stringify(["subagent-canonical", parent.sessionId, "1-child-b"]);
		const childAPersistence = createManagedTaskPersistence(artifacts, "0-child-a");
		const childBPersistence = createManagedTaskPersistence(artifacts, "1-child-b");
		const [{ session: childA, authStorage: authA }, { session: childB, authStorage: authB }] = await Promise.all([
			createSession(tempDir, {
				forkContextSeed: seedA,
				providerSessionId: childAProviderSessionId,
				sessionManager: await withLifecycleIdentity(parent.sessionId, () => childAPersistence.openSession(tempDir)),
			}),
			createSession(tempDir, {
				forkContextSeed: seedB,
				providerSessionId: childBProviderSessionId,
				sessionManager: await withLifecycleIdentity(parent.sessionId, () => childBPersistence.openSession(tempDir)),
			}),
		]);
		sessions.push(childA, childB);
		authStorages.push(authA, authB);

		expect(childA.messages.slice(0, seedA.agentMessages.length)).toEqual(seedA.agentMessages);
		expect(childA.sessionManager.getSessionFile()).toBe(path.join(artifactsDir, "0-child-a.jsonl"));
		expect(childB.sessionManager.getSessionFile()).toBe(path.join(artifactsDir, "1-child-b.jsonl"));
		// Nested managed persistence intentionally preserves the lifecycle-owned logical
		// header while provider continuity must be child-owned and collision-free.
		expect(childA.sessionManager.getSessionId()).toBe(parent.sessionManager.getSessionId());
		expect(childB.sessionManager.getSessionId()).toBe(parent.sessionManager.getSessionId());
		expect(childA.agent.providerSessionId).not.toBe(parent.sessionId);
		expect(childB.agent.providerSessionId).not.toBe(parent.sessionId);
		expect(childA.agent.providerSessionId).not.toBe(childB.agent.providerSessionId);
	}, 15_000);

	it("keeps a nested managed child provider identity across detached resume", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-task-detached-resume-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const { session: parent, authStorage: parentAuth } = await createSession(tempDir);
		sessions.push(parent);
		authStorages.push(parentAuth);
		parent.agent.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });
		const seed = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		const root = managedDirectoryRoot(tempDir);
		const artifactsDir = path.join(root.canonicalPath, "artifacts");
		const artifactStore = new ManagedSessionDescendantStore(root, artifactsDir);
		artifactStores.push(artifactStore);
		const artifacts = new ArtifactManager(artifactStore);
		const persistence = createManagedTaskPersistence(artifacts, "0-resumable-child");
		const childProviderSessionId = JSON.stringify(["subagent-canonical", parent.sessionId, "0-resumable-child"]);
		const { session: child, authStorage: childAuth } = await createSession(tempDir, {
			forkContextSeed: seed,
			providerSessionId: childProviderSessionId,
			sessionManager: await withLifecycleIdentity(parent.sessionId, () => persistence.openSession(tempDir)),
		});
		sessions.push(child);
		authStorages.push(childAuth);
		expect(child.agent.providerSessionId).toBe(childProviderSessionId);
		const persistedTurn: Message = {
			role: "user",
			content: [{ type: "text", text: "persisted child turn" }],
			attribution: "user",
			timestamp: Date.now(),
		};
		child.agent.appendMessage(persistedTurn);
		child.sessionManager.appendMessage(persistedTurn);
		await child.sessionManager.flush();
		await child.dispose();

		const { session: resumed, authStorage: resumedAuth } = await createSession(tempDir, {
			forkContextSeed: seed,
			providerSessionId: childProviderSessionId,
			sessionManager: await withLifecycleIdentity(parent.sessionId, () => persistence.openSession(tempDir)),
		});
		sessions.push(resumed);
		authStorages.push(resumedAuth);

		expect(resumed.sessionManager.getSessionId()).toBe(parent.sessionManager.getSessionId());
		expect(resumed.agent.providerSessionId).toBe(childProviderSessionId);
		expect(resumed.agent.providerSessionId).not.toBe(parent.sessionId);
		const restoredContent = resumed.messages.map(message => JSON.stringify(message));
		expect(restoredContent.some(content => content.includes("persisted child turn"))).toBe(true);
		expect(restoredContent.some(content => content.includes("parent context"))).toBe(false);
	}, 15_000);

	it("honors an explicit providerSessionId over the fork seed and logical id", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-task-explicit-id-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const { session, authStorage } = await createSession(tempDir, {
			forkContextSeed: createHandBuiltSeed(),
			providerSessionId: "explicit-provider-session",
		});
		sessions.push(session);
		authStorages.push(authStorage);

		expect(session.agent.providerSessionId).toBe("explicit-provider-session");
	});

	it("keeps top-level async ownership isolated when provider affinity is shared", async () => {
		await withoutLifecycleIdentity(async () => {
			const firstDir = await fsPromises.mkdtemp(
				path.join(os.tmpdir(), `pi-task-shared-provider-a-${Snowflake.next()}-`),
			);
			const secondDir = await fsPromises.mkdtemp(
				path.join(os.tmpdir(), `pi-task-shared-provider-b-${Snowflake.next()}-`),
			);
			tempDirs.push(firstDir, secondDir);
			const [{ session: first, authStorage: firstAuth }, { session: second, authStorage: secondAuth }] =
				await Promise.all([
					createSession(firstDir, { providerSessionId: "shared-provider-affinity" }),
					createSession(secondDir, { providerSessionId: "shared-provider-affinity" }),
				]);
			sessions.push(first, second);
			authStorages.push(firstAuth, secondAuth);

			expect(first.agent.providerSessionId).toBe("shared-provider-affinity");
			expect(second.agent.providerSessionId).toBe("shared-provider-affinity");
			expect(first.sessionManager.getSessionId()).not.toBe(second.sessionManager.getSessionId());
		});
	}, 15_000);

	it("rekeys explicit provider ownership to the successor transcript and frees the predecessor", async () => {
		await withoutLifecycleIdentity(async () => {
			const tempDir = await fsPromises.mkdtemp(
				path.join(os.tmpdir(), `pi-task-provider-transition-${Snowflake.next()}-`),
			);
			tempDirs.push(tempDir);
			const providerSessionId = "shared-provider-affinity";
			const { session, authStorage } = await createSession(tempDir, { providerSessionId });
			sessions.push(session);
			authStorages.push(authStorage);

			const previousSessionId = session.sessionManager.getSessionId();
			const previousSessionFile = session.sessionManager.getSessionFile();
			expect(previousSessionFile).toBeDefined();
			expect(fs.existsSync(previousSessionFile!)).toBe(false);
			const previousEndpoint = JSON.stringify([
				"async-job-endpoint",
				providerSessionId,
				stablePathKey(path.resolve(previousSessionFile!)),
			]);
			const manager = AsyncJobManager.forEndpoint(previousEndpoint);
			expect(manager).toBeDefined();
			session.sessionManager.appendMessage({
				role: "user",
				content: "persist endpoint identity",
				timestamp: Date.now(),
			});
			await session.sessionManager.ensureOnDisk();
			await session.sessionManager.flush();
			expect(fs.existsSync(previousSessionFile!)).toBe(true);
			expect(asyncJobEndpointId(providerSessionId, previousSessionId, previousSessionFile)).toBe(previousEndpoint);
			expect(AsyncJobManager.forEndpoint(previousEndpoint)).toBe(manager);

			await session.sessionManager.rewriteEntries();
			expect(asyncJobEndpointId(providerSessionId, previousSessionId, previousSessionFile)).toBe(previousEndpoint);
			expect(AsyncJobManager.forEndpoint(previousEndpoint)).toBe(manager);

			expect(await session.newSession()).toBe(true);
			const successorSessionFile = session.sessionManager.getSessionFile();
			expect(successorSessionFile).toBeDefined();
			expect(session.sessionManager.getSessionId()).not.toBe(previousSessionId);
			const successorEndpoint = JSON.stringify([
				"async-job-endpoint",
				providerSessionId,
				stablePathKey(path.resolve(successorSessionFile!)),
			]);
			expect(AsyncJobManager.forEndpoint(previousEndpoint)).toBeUndefined();
			expect(AsyncJobManager.forEndpoint(successorEndpoint)).toBe(manager);

			expect(await session.switchSession(previousSessionFile!)).toBe(true);
			expect(AsyncJobManager.forEndpoint(successorEndpoint)).toBeUndefined();
			expect(AsyncJobManager.forEndpoint(previousEndpoint)).toBe(manager);

			const { session: reopened, authStorage: reopenedAuth } = await createSession(tempDir, {
				providerSessionId,
				sessionManager: await SessionManager.open(successorSessionFile!),
			});
			sessions.push(reopened);
			authStorages.push(reopenedAuth);
			expect(AsyncJobManager.forEndpoint(successorEndpoint)).toBeDefined();
		});
	}, 15_000);

	it("registers construction-time ownership under the shared canonical endpoint key", async () => {
		await withoutLifecycleIdentity(async () => {
			const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-task-provider-alias-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const providerSessionId = "aliased-provider-affinity";
			const { session, authStorage } = await createSession(tempDir, { providerSessionId });
			sessions.push(session);
			authStorages.push(authStorage);

			// The constructor must register under exactly the key the transition path
			// recomputes; any divergence strands ownership on the first transition.
			const predecessorFile = session.sessionManager.getSessionFile();
			expect(predecessorFile).toBeDefined();
			const predecessorEndpoint = asyncJobEndpointId(
				providerSessionId,
				session.sessionManager.getSessionId(),
				predecessorFile,
			);
			const manager = AsyncJobManager.forEndpoint(predecessorEndpoint);
			expect(manager).toBeDefined();
			expect(AsyncJobManager.endpointIdOf(manager!)).toBe(predecessorEndpoint);

			expect(await session.newSession()).toBe(true);
			const successorEndpoint = asyncJobEndpointId(
				providerSessionId,
				session.sessionManager.getSessionId(),
				session.sessionManager.getSessionFile(),
			);
			expect(successorEndpoint).not.toBe(predecessorEndpoint);
			expect(AsyncJobManager.forEndpoint(predecessorEndpoint)).toBeUndefined();
			expect(AsyncJobManager.forEndpoint(successorEndpoint)).toBe(manager);
		});
	}, 15_000);

	it("does not share mutable provider state unless explicitly supplied", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-task-provider-state-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const parentState = new Map<string, ProviderSessionState>();
		parentState.set("openai-responses:openai", { close: () => {} });
		const { session, authStorage } = await createSession(tempDir, { forkContextSeed: createHandBuiltSeed() });
		sessions.push(session);
		authStorages.push(authStorage);

		expect(session.providerSessionState).not.toBe(parentState);
		expect(session.providerSessionState.size).toBe(0);
	});
});
