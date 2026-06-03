import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@gajae-code/coding-agent/internal-urls";
import { getMemoryRoot } from "@gajae-code/coding-agent/memories";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { AgentRegistry } from "../../src/registry/agent-registry";

interface MemoryFixture {
	cwd: string;
	memoryRoot: string;
	agentDir: string;
	cleanupRoot: string;
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
		const memoryRoot = getMemoryRoot(agentDir, cwd);
		await fs.mkdir(memoryRoot, { recursive: true });
		AgentRegistry.global().register({
			id: "test-main",
			displayName: "test",
			kind: "main",
			session: {
				settings: {
					getAgentDir: () => agentDir,
				},
				sessionManager: {
					getCwd: () => cwd,
					getArtifactsDir: () => null,
					getSessionId: () => "test",
				},
			} as unknown as AgentSession,
			sessionFile: null,
		});
		await fn({ cwd, memoryRoot, agentDir, cleanupRoot });
	} finally {
		setAgentDir(previousAgentDir);
		await fs.rm(cleanupRoot, { recursive: true, force: true });
	}
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

	it("resolves memory://root to memory_summary.md", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			await Bun.write(path.join(memoryRoot, "memory_summary.md"), "summary");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root");

			expect(resource.content).toBe("summary");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("uses the registered session agent dir instead of the process-global agent dir", async () => {
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

			const sessionMemoryRoot = getMemoryRoot(sessionAgentDir, cwd);
			await fs.mkdir(sessionMemoryRoot, { recursive: true });
			await Bun.write(path.join(sessionMemoryRoot, "memory_summary.md"), "session-agent summary");

			AgentRegistry.global().register({
				id: "test-main",
				displayName: "test",
				kind: "main",
				session: {
					settings: {
						getAgentDir: () => sessionAgentDir,
					},
					sessionManager: {
						getCwd: () => cwd,
						getArtifactsDir: () => null,
						getSessionId: () => "test",
					},
				} as unknown as AgentSession,
				sessionFile: null,
			});

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root");

			expect(resource.content).toBe("session-agent summary");
			const sourcePath = resource.sourcePath;
			if (sourcePath === undefined) throw new Error("Expected memory resource source path");
			const realSessionMemoryRoot = await fs.realpath(sessionMemoryRoot);
			expect(sourcePath.startsWith(realSessionMemoryRoot)).toBe(true);
		} finally {
			setAgentDir(previousAgentDir);
			await fs.rm(cleanupRoot, { recursive: true, force: true });
		}
	});

	it("resolves memory://root/<path> within memory root", async () => {
		await withMemoryFixture(async ({ memoryRoot }) => {
			const skillPath = path.join(memoryRoot, "skills", "demo", "SKILL.md");
			await fs.mkdir(path.dirname(skillPath), { recursive: true });
			await Bun.write(skillPath, "demo skill");

			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("memory://root/skills/demo/SKILL.md");

			expect(resource.content).toBe("demo skill");
			expect(resource.contentType).toBe("text/markdown");
		});
	});

	it("throws for unknown memory namespace", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://other/memory_summary.md")).rejects.toThrow(
				"Unknown memory namespace: other. Supported: root",
			);
		});
	});

	it("blocks path traversal attempts", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/../secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
			await expect(router.resolve("memory://root/%2E%2E/secret.md")).rejects.toThrow(
				"Path traversal (..) is not allowed in memory:// URLs",
			);
		});
	});

	it("throws clear error for missing files", async () => {
		await withMemoryFixture(async () => {
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/missing.md")).rejects.toThrow(
				"Memory file not found: memory://root/missing.md",
			);
		});
	});

	it("blocks symlink escapes outside memory root", async () => {
		if (process.platform === "win32") return;

		await withMemoryFixture(async ({ memoryRoot, cleanupRoot }) => {
			const outsideDir = path.join(cleanupRoot, "outside");
			await fs.mkdir(outsideDir, { recursive: true });
			await Bun.write(path.join(outsideDir, "secret.md"), "secret");
			await fs.symlink(outsideDir, path.join(memoryRoot, "linked"));

			const router = InternalUrlRouter.instance();
			await expect(router.resolve("memory://root/linked/secret.md")).rejects.toThrow(
				"memory:// URL escapes memory root",
			);
		});
	});
});
