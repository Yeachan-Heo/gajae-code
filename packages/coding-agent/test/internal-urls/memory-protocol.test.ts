import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	InternalUrlRouter,
	MemoryProtocolError,
	resolveMemoryUrlToPathSync,
} from "@gajae-code/coding-agent/internal-urls";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { resolveScopes } from "@gajae-code/memory-core";
import { getAgentDir, getMemoryRootDir, setAgentDir } from "@gajae-code/utils";
import { buildMemoryEnvironment, buildMemoryEnvironmentSync } from "../../src/cli/memory/environment";
import { getMemoryRoot } from "../../src/memories";
import { AgentRegistry } from "../../src/registry/agent-registry";

interface MemoryFixture {
	cwd: string;
	memoryRoot: string;
	agentDir: string;
	cleanupRoot: string;
}

function memoryDocument(
	scope: "global" | "project" | "session",
	id: string,
	body: string,
	sensitivity = "public-safe",
): string {
	return `---
schemaVersion: gajae.memory.document.v1
id: ${id}
type: fact
scope: ${scope}
authority: user-confirmed
volatility: stable
sensitivity: ${sensitivity}
status: active
created: 2026-07-29T10:00:00Z
updated: 2026-07-29T10:00:00.000Z
aliases: []
supersedes: []
verification:
  provider: test
  resource: fixture
  id: ${id}
---
# ${id}
${body}
`;
}

async function writeDocument(
	memoryRoot: string,
	relPath: string,
	scope: "global" | "project" | "session",
	id: string,
	body: string,
	sensitivity = "public-safe",
): Promise<void> {
	const target = path.join(memoryRoot, relPath);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, memoryDocument(scope, id, body, sensitivity), "utf8");
}

async function expectSameFile(left: string | undefined, right: string): Promise<void> {
	expect(left).toBeDefined();
	if (left === undefined) return;
	expect(await fs.realpath(left)).toBe(await fs.realpath(right));
}

function registerSession(id: string, agentDir: string, cwd: string): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "main",
		session: {
			settings: {
				getAgentDir: () => agentDir,
			},
			sessionManager: {
				getCwd: () => cwd,
				getArtifactsDir: () => null,
				getSessionId: () => id,
			},
		} as unknown as AgentSession,
		sessionFile: null,
	});
}

async function withMemoryFixture(fn: (fixture: MemoryFixture) => Promise<void>): Promise<void> {
	const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-"));
	const previousAgentDir = getAgentDir();
	try {
		const agentDir = path.join(cleanupRoot, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		const cwd = path.join(cleanupRoot, "project");
		await fs.mkdir(cwd, { recursive: true });
		setAgentDir(agentDir);
		const memoryRoot = getMemoryRootDir(agentDir);
		await fs.mkdir(memoryRoot, { recursive: true, mode: 0o700 });
		await fs.chmod(memoryRoot, 0o700);
		registerSession("test", agentDir, cwd);
		await fn({ cwd, memoryRoot, agentDir, cleanupRoot });
	} finally {
		setAgentDir(previousAgentDir);
		await fs.rm(cleanupRoot, { recursive: true, force: true });
	}
}

function expectMemoryError(error: unknown, code: MemoryProtocolError["code"]): MemoryProtocolError {
	expect(error).toBeInstanceOf(MemoryProtocolError);
	if (!(error instanceof MemoryProtocolError)) throw error;
	expect(error.code).toBe(code);
	return error;
}

describe("MemoryProtocolHandler", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("maps memory://global to the public global core scope", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await writeDocument(memoryRoot, "global/summary.md", "global", "summary", "summary");

			const resource = await InternalUrlRouter.instance().resolve("memory://global/summary.md");

			expect(resource.content).toContain("summary");
			expect(resource.contentType).toBe("text/markdown");
			expect(resource.size).toBe(Buffer.byteLength(resource.content, "utf8"));
			expect(resource.sourcePath).toBeUndefined();
		});
	});

	it("preserves the registered session agent dir instead of the process-global agent dir", async () => {
		const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-custom-agent-"));
		const previousAgentDir = getAgentDir();
		try {
			const globalAgentDir = path.join(cleanupRoot, "global-agent");
			const sessionAgentDir = path.join(cleanupRoot, "session-agent");
			const cwd = path.join(cleanupRoot, "project");
			await fs.mkdir(globalAgentDir, { recursive: true });
			await fs.mkdir(sessionAgentDir, { recursive: true });
			await fs.mkdir(cwd, { recursive: true });
			setAgentDir(globalAgentDir);

			const sessionMemoryRoot = getMemoryRootDir(sessionAgentDir);
			await fs.mkdir(sessionMemoryRoot, { recursive: true, mode: 0o700 });
			await fs.chmod(sessionMemoryRoot, 0o700);
			await writeDocument(
				sessionMemoryRoot,
				"global/summary.md",
				"global",
				"session-summary",
				"session-agent summary",
			);
			registerSession("test", sessionAgentDir, cwd);

			const resource = await InternalUrlRouter.instance().resolve("memory://global/summary.md");

			expect(resource.content).toContain("session-agent summary");
			expect(JSON.stringify(resource)).not.toContain(globalAgentDir);
		} finally {
			setAgentDir(previousAgentDir);
			await fs.rm(cleanupRoot, { recursive: true, force: true });
		}
	});

	it("maps memory://session to the owning session scope", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await writeDocument(memoryRoot, "sessions/test/checkpoint.md", "session", "checkpoint", "session checkpoint");

			const resource = await InternalUrlRouter.instance().resolve("memory://session/test/checkpoint.md");

			expect(resource.content).toContain("session checkpoint");
		});
	});

	it("resolves each custom session independently and rejects an unowned request", async () => {
		const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-protocol-two-sessions-"));
		try {
			const agentDirA = path.join(cleanupRoot, "agent-a");
			const agentDirB = path.join(cleanupRoot, "agent-b");
			const cwdA = path.join(cleanupRoot, "project-a");
			const cwdB = path.join(cleanupRoot, "project-b");
			await Promise.all([
				fs.mkdir(agentDirA, { recursive: true }),
				fs.mkdir(agentDirB, { recursive: true }),
				fs.mkdir(cwdA, { recursive: true }),
				fs.mkdir(cwdB, { recursive: true }),
			]);
			const memoryRootA = getMemoryRootDir(agentDirA);
			const memoryRootB = getMemoryRootDir(agentDirB);
			await Promise.all([
				fs.mkdir(memoryRootA, { recursive: true, mode: 0o700 }),
				fs.mkdir(memoryRootB, { recursive: true, mode: 0o700 }),
			]);
			await Promise.all([fs.chmod(memoryRootA, 0o700), fs.chmod(memoryRootB, 0o700)]);
			await writeDocument(memoryRootA, "global/summary.md", "global", "a", "from session A");
			await writeDocument(memoryRootB, "global/summary.md", "global", "b", "from session B");
			registerSession("session-a", agentDirA, cwdA);
			registerSession("session-b", agentDirB, cwdB);

			const router = InternalUrlRouter.instance();
			const unowned = await router.resolve("memory://global/summary.md").catch(error => error);
			expectMemoryError(unowned, "scope-unresolved");
			await expect(router.resolve("memory://global/summary.md", { cwd: cwdA })).resolves.toMatchObject({
				content: expect.stringContaining("from session A"),
			});
			await expect(router.resolve("memory://global/summary.md", { cwd: cwdB })).resolves.toMatchObject({
				content: expect.stringContaining("from session B"),
			});
		} finally {
			await fs.rm(cleanupRoot, { recursive: true, force: true });
		}
	});

	it("keeps resolving the legacy root namespace through the pre-M7 memories adapter", async () => {
		await withMemoryFixture(async ({ agentDir, cwd }) => {
			const legacyRoot = getMemoryRoot(agentDir, cwd);
			await fs.mkdir(legacyRoot, { recursive: true });
			await fs.writeFile(path.join(legacyRoot, "memory_summary.md"), "# legacy summary\nstill served\n", "utf8");

			const resource = await InternalUrlRouter.instance().resolve("memory://root/memory_summary.md");
			expect(resource.content).toContain("still served");
			const expectedPath = path.join(legacyRoot, "memory_summary.md");
			await expectSameFile(resource.sourcePath, expectedPath);
			await expectSameFile(resolveMemoryUrlToPathSync("memory://root/memory_summary.md"), expectedPath);
		});
	});

	it("fails closed when a legacy root leaf symlinks outside the legacy root", async () => {
		if (process.platform === "win32") return;

		await withMemoryFixture(async ({ agentDir, cwd, cleanupRoot }) => {
			const legacyRoot = getMemoryRoot(agentDir, cwd);
			await fs.mkdir(legacyRoot, { recursive: true });
			const outside = path.join(cleanupRoot, "outside-secret.md");
			await fs.writeFile(outside, "# outside\nescaped bytes\n", "utf8");
			await fs.symlink(outside, path.join(legacyRoot, "escape.md"));

			expect(() => resolveMemoryUrlToPathSync("memory://root/escape.md")).toThrow();
			await expect(InternalUrlRouter.instance().resolve("memory://root/escape.md")).rejects.toThrow();
		});
	});

	it("rejects unknown namespaces with typed invalid-input errors", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			const unknown = await router.resolve("memory://other/summary.md").catch(error => error);

			expectMemoryError(unknown, "invalid-input");
		});
	});

	it("rejects traversal with a typed core URI error", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			const plain = await router.resolve("memory://global/../secret.md").catch(error => error);
			const encoded = await router.resolve("memory://global/%2E%2E/secret.md").catch(error => error);

			expectMemoryError(plain, "invalid-input");
			expectMemoryError(encoded, "invalid-input");
		});
	});

	it("fails closed with a typed not-initialized error when the root is absent", async () => {
		await withMemoryFixture(async ({ memoryRoot, cleanupRoot }) => {
			await fs.rm(memoryRoot, { recursive: true, force: true });
			const error = await InternalUrlRouter.instance()
				.resolve("memory://global/missing.md")
				.catch(value => value);

			const typed = expectMemoryError(error, "not-initialized");
			expect(typed.memoryError).not.toHaveProperty("memoryRoot");
			expect(JSON.stringify(typed)).not.toContain(cleanupRoot);
		});
	});

	it("gates on the initialized root before any repository discovery", async () => {
		await withMemoryFixture(async ({ cwd, memoryRoot }) => {
			// Removing the working directory makes repository discovery observable: if the
			// protocol built an environment first it would fail closed as policy-denied.
			await fs.rm(memoryRoot, { recursive: true, force: true });
			await fs.rm(cwd, { recursive: true, force: true });

			const asyncError = await InternalUrlRouter.instance()
				.resolve("memory://global/missing.md")
				.catch(value => value);
			expectMemoryError(asyncError, "not-initialized");

			let syncError: unknown;
			try {
				resolveMemoryUrlToPathSync("memory://global/missing.md");
			} catch (error) {
				syncError = error;
			}
			expectMemoryError(syncError, "not-initialized");
		});
	});

	it("rejects private documents before disclosure", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await writeDocument(memoryRoot, "global/private.md", "global", "private", "private data", "private");
			const error = await InternalUrlRouter.instance()
				.resolve("memory://global/private.md")
				.catch(value => value);

			expectMemoryError(error, "sensitivity-violation");
		});
	});

	it("rejects symlinked scope paths outside the memory root", async () => {
		if (process.platform === "win32") return;

		await withMemoryFixture(async ({ memoryRoot, cleanupRoot }) => {
			const outsideDir = path.join(cleanupRoot, "outside");
			await fs.mkdir(outsideDir, { recursive: true });
			await writeDocument(outsideDir, "secret.md", "global", "secret", "secret");
			await fs.mkdir(path.join(memoryRoot, "global"), { recursive: true });
			await fs.symlink(outsideDir, path.join(memoryRoot, "global", "linked"));

			const error = await InternalUrlRouter.instance()
				.resolve("memory://global/linked/secret.md")
				.catch(value => value);
			expectMemoryError(error, "policy-denied");
		});
	});

	it("keeps sync and async project identity aligned for forge remotes", async () => {
		await withMemoryFixture(async ({ cwd, memoryRoot, agentDir }) => {
			// A hand-written .git directory is not a usable repository: `git remote`
			// fails outright, so create a real one with a forge remote.
			const git = async (...args: readonly string[]): Promise<void> => {
				const spawned = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
				if (spawned.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
			};
			await git("init", "--quiet");
			await git("remote", "add", "origin", "https://github.com/acme/forge-repo.git");

			const environmentOptions = {
				settings: { getAgentDir: () => agentDir },
				cwd,
				clock: () => new Date(0),
				session: { flagValue: "test" },
			};
			const asyncEnvironment = await buildMemoryEnvironment(environmentOptions);
			const syncEnvironment = buildMemoryEnvironmentSync(environmentOptions);
			const asyncScopes = resolveScopes(asyncEnvironment);
			const syncScopes = resolveScopes(syncEnvironment);
			if (!asyncScopes.ok || !syncScopes.ok) throw new Error("project scope resolution failed");
			expect(asyncScopes.value.projectKey).toBe(syncScopes.value.projectKey);
			const projectKey = asyncScopes.value.projectKey;
			if (projectKey === null) throw new Error("forge remote did not produce a project key");

			await writeDocument(
				memoryRoot,
				`projects/${projectKey}/summary.md`,
				"project",
				"forge-summary",
				"forge summary",
			);
			const url = `memory://project/${projectKey}/summary.md`;
			const syncPath = resolveMemoryUrlToPathSync(url);
			const asyncResource = await InternalUrlRouter.instance().resolve(url);
			const expectedPath = path.join(memoryRoot, "projects", projectKey, "summary.md");
			await expectSameFile(syncPath, expectedPath);
			expect(asyncResource.content).toContain("forge summary");
		});
	});
});
