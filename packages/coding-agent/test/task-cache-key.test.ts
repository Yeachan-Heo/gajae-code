import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
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

/**
 * Default budget for every test in this file.
 *
 * Building a session touches SQLite, the model registry and the filesystem. On
 * a cold Windows runner that comfortably exceeds Bun's implicit 5s default, and
 * a test that overruns is aborted mid-flight: the abort skips the rest of the
 * body, so a credential store opened before the build would stay locked and the
 * temp tree could no longer be removed.
 */
setDefaultTimeout(15_000);

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

/**
 * Credential stores opened by {@link createSession}, tracked here so the
 * cleanup always releases their SQLite handle.
 *
 * A store is registered the moment it is created, before the session build
 * starts. A session build that never settles (a slow Windows CI runner, a
 * wedged provider probe) aborts the test mid-flight, and an unregistered store
 * keeps its database file open: the temp tree can then no longer be removed
 * and Windows reports EBUSY on the still-open file, which masks the real
 * failure behind a cleanup error.
 */
const openAuthStorages: AuthStorage[] = [];

/**
 * Release every tracked credential store.
 *
 * Bun aborts a test body when it exceeds its timeout, so a session build that
 * never settles never runs the `catch` in {@link createSession}. The registry
 * is the only thing that can still release the handle in that case.
 */
function closeAuthStorageForCleanup(storage: AuthStorage): void {
	try {
		storage.close();
	} catch {
		// A store another owner already closed must not hide the temp-tree removal.
	}
}

function releaseTrackedAuthStorages(): void {
	while (openAuthStorages.length > 0) {
		const storage = openAuthStorages.pop();
		if (storage) closeAuthStorageForCleanup(storage);
	}
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
	// Register before the build so an aborted build still leaves a handle the
	// cleanup can release.
	openAuthStorages.push(authStorage);
	try {
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
		return { session: result.session };
	} catch (error) {
		// The caller never receives the store, so release it here instead of
		// leaving a live handle behind for the cleanup to trip over. Closing
		// twice is a no-op, so the registry entry can stay.
		closeAuthStorageForCleanup(authStorage);
		throw error;
	}
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
		for (const entry of await fsPromises.readdir(dir, { withFileTypes: true })) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				await removeTempTree(entryPath);
			} else {
				try {
					await fsPromises.rm(entryPath, { force: true });
				} catch (error) {
					throw new Error(`Failed to remove entry ${entryPath}`, { cause: error });
				}
			}
		}
		try {
			await fsPromises.rmdir(dir);
		} catch (error) {
			throw new Error(`Failed to remove directory ${dir}`, { cause: error });
		}
	}

	afterEach(async () => {
		while (sessions.length > 0) await sessions.pop()?.dispose();
		releaseTrackedAuthStorages();
		while (artifactStores.length > 0) artifactStores.pop()?.close();
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (!tempDir) continue;
			const modelCacheClosed = closeModelCache(path.join(tempDir, "models.db"));
			releaseTrackedAuthStorages();
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
		const { session: parent } = await createSession(tempDir);
		sessions.push(parent);
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
		const [{ session: childA }, { session: childB }] = await Promise.all([
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
		const { session: parent } = await createSession(tempDir);
		sessions.push(parent);
		parent.agent.appendMessage({ role: "user", content: "parent context", timestamp: Date.now() });
		const seed = await parent.buildForkContextSeed({ maxMessages: 50, maxTokens: 10_000 });
		const root = managedDirectoryRoot(tempDir);
		const artifactsDir = path.join(root.canonicalPath, "artifacts");
		const artifactStore = new ManagedSessionDescendantStore(root, artifactsDir);
		artifactStores.push(artifactStore);
		const artifacts = new ArtifactManager(artifactStore);
		const persistence = createManagedTaskPersistence(artifacts, "0-resumable-child");
		const childProviderSessionId = JSON.stringify(["subagent-canonical", parent.sessionId, "0-resumable-child"]);
		const { session: child } = await createSession(tempDir, {
			forkContextSeed: seed,
			providerSessionId: childProviderSessionId,
			sessionManager: await withLifecycleIdentity(parent.sessionId, () => persistence.openSession(tempDir)),
		});
		sessions.push(child);
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

		const { session: resumed } = await createSession(tempDir, {
			forkContextSeed: seed,
			providerSessionId: childProviderSessionId,
			sessionManager: await withLifecycleIdentity(parent.sessionId, () => persistence.openSession(tempDir)),
		});
		sessions.push(resumed);

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
		const { session } = await createSession(tempDir, {
			forkContextSeed: createHandBuiltSeed(),
			providerSessionId: "explicit-provider-session",
		});
		sessions.push(session);

		expect(session.agent.providerSessionId).toBe("explicit-provider-session");
	}, 15_000);

	it("keeps top-level async ownership isolated when provider affinity is shared", async () => {
		const firstDir = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), `pi-task-shared-provider-a-${Snowflake.next()}-`),
		);
		const secondDir = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), `pi-task-shared-provider-b-${Snowflake.next()}-`),
		);
		tempDirs.push(firstDir, secondDir);
		const [{ session: first }, { session: second }] = await Promise.all([
			createSession(firstDir, { providerSessionId: "shared-provider-affinity" }),
			createSession(secondDir, { providerSessionId: "shared-provider-affinity" }),
		]);
		sessions.push(first, second);

		expect(first.agent.providerSessionId).toBe("shared-provider-affinity");
		expect(second.agent.providerSessionId).toBe("shared-provider-affinity");
		expect(first.sessionManager.getSessionId()).not.toBe(second.sessionManager.getSessionId());
	}, 15_000);

	it("rekeys explicit provider ownership to the successor transcript and frees the predecessor", async () => {
		const tempDir = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), `pi-task-provider-transition-${Snowflake.next()}-`),
		);
		tempDirs.push(tempDir);
		const providerSessionId = "shared-provider-affinity";
		const { session } = await createSession(tempDir, { providerSessionId });
		sessions.push(session);

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

		const { session: reopened } = await createSession(tempDir, {
			providerSessionId,
			sessionManager: await SessionManager.open(successorSessionFile!),
		});
		sessions.push(reopened);
		expect(AsyncJobManager.forEndpoint(successorEndpoint)).toBeDefined();
	}, 15_000);

	it("registers construction-time ownership under the shared canonical endpoint key", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-task-provider-alias-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const providerSessionId = "aliased-provider-affinity";
		const { session } = await createSession(tempDir, { providerSessionId });
		sessions.push(session);

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
	}, 15_000);

	it("does not share mutable provider state unless explicitly supplied", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-task-provider-state-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const parentState = new Map<string, ProviderSessionState>();
		parentState.set("openai-responses:openai", { close: () => {} });
		const { session } = await createSession(tempDir, { forkContextSeed: createHandBuiltSeed() });
		sessions.push(session);

		expect(session.providerSessionState).not.toBe(parentState);
		expect(session.providerSessionState.size).toBe(0);
	}, 15_000);

	it("registers the credential store before the session build so an aborted build still releases it", async () => {
		const tempDir = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), `pi-task-store-registration-${Snowflake.next()}-`),
		);
		tempDirs.push(tempDir);
		const before = openAuthStorages.length;
		const manager = SessionManager.create(tempDir, tempDir);
		let observedDuringBuild = -1;
		const observed = new Proxy(manager, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (observedDuringBuild < 0) observedDuringBuild = openAuthStorages.length;
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
		const { session } = await createSession(tempDir, { sessionManager: observed });
		sessions.push(session);

		// The store must already be tracked while the build runs: a build that
		// never settles is aborted by the runner, so the cleanup is the only
		// thing that can still release the SQLite handle.
		expect(observedDuringBuild).toBe(before + 1);
	}, 15_000);

	it("releases every tracked credential store on cleanup", async () => {
		const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-task-store-release-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		openAuthStorages.push(authStorage);

		releaseTrackedAuthStorages();

		// A released store refuses further work on its closed database.
		expect(() => authStorage.allocateMonotonicSequence("probe", 60)).toThrow(/closed database/i);
	}, 15_000);

	it("releases the credential store when the session build fails", async () => {
		const tempDir = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), `pi-task-store-build-failure-${Snowflake.next()}-`),
		);
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		const failing = new Proxy(manager, {
			get(target, property) {
				if (property === "getSessionId") {
					return () => {
						throw new Error("forced session build failure");
					};
				}
				const value = Reflect.get(target, property);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
			},
		});

		await expect(createSession(tempDir, { sessionManager: failing })).rejects.toThrow("forced session build failure");

		// The caller never receives the store, so the failure path has to
		// release it: an open handle keeps the database file locked and the
		// temp tree can no longer be removed.
		const store = openAuthStorages[openAuthStorages.length - 1];
		expect(store).toBeDefined();
		expect(() => store?.allocateMonotonicSequence("probe", 60)).toThrow(/closed database/i);
	}, 15_000);
});
