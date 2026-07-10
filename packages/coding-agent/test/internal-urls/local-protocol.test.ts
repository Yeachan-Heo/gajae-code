import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	InternalUrlRouter,
	LocalProtocolHandler,
	resolveLocalRoot,
	resolveLocalUrlToPath,
} from "@gajae-code/coding-agent/internal-urls";
import { AgentRegistry } from "@gajae-code/coding-agent/registry/agent-registry";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("LocalProtocolHandler", () => {
	beforeEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		LocalProtocolHandler.resetOverrideForTests();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	it("prefers explicit owned mappings over a live main registry session", () => {
		AgentRegistry.global().register({
			id: "main",
			displayName: "main",
			kind: "main",
			status: "running",
			session: {
				sessionManager: {
					getArtifactsDir: () => "/registry-artifacts",
					getSessionId: () => "registry-session",
				},
			} as unknown as AgentSession,
		});
		const owned = { getArtifactsDir: () => "/owned-artifacts", getSessionId: () => "owned-session" };
		const dispose = LocalProtocolHandler.installOverride(owned);

		expect(LocalProtocolHandler.resolveOptions()).toBe(owned);

		dispose();
		const fallback = LocalProtocolHandler.resolveOptions();
		expect(fallback?.getArtifactsDir?.()).toBe("/registry-artifacts");
		expect(fallback?.getSessionId?.()).toBe("registry-session");
	});

	it("uses only live main registry sessions as the fallback", () => {
		const session = {
			sessionManager: {
				getArtifactsDir: () => "/registry-artifacts",
				getSessionId: () => "registry-session",
			},
		} as unknown as AgentSession;
		const resolveForStatus = (status: "idle" | "completed" | "aborted") => {
			AgentRegistry.resetGlobalForTests();
			AgentRegistry.global().register({
				id: "main",
				displayName: "main",
				kind: "main",
				status,
				session,
			});
			return LocalProtocolHandler.resolveOptions();
		};

		const idle = resolveForStatus("idle");
		expect(idle?.getArtifactsDir?.()).toBe("/registry-artifacts");
		expect(idle?.getSessionId?.()).toBe("registry-session");
		expect(resolveForStatus("completed")).toBeUndefined();
		expect(resolveForStatus("aborted")).toBeUndefined();
	});

	it("keeps the newest owned mapping live until its exact disposer runs", () => {
		const first = { getArtifactsDir: () => "/first", getSessionId: () => "first" };
		const second = { getArtifactsDir: () => "/second", getSessionId: () => "second" };
		const third = { getArtifactsDir: () => "/third", getSessionId: () => "third" };
		const disposeFirst = LocalProtocolHandler.installOverride(first);
		const disposeSecond = LocalProtocolHandler.installOverride(second);
		const disposeThird = LocalProtocolHandler.installOverride(third);

		expect(LocalProtocolHandler.resolveOptions()).toBe(third);
		disposeSecond();
		expect(LocalProtocolHandler.resolveOptions()).toBe(third);
		disposeSecond();
		expect(LocalProtocolHandler.resolveOptions()).toBe(third);
		disposeThird();
		expect(LocalProtocolHandler.resolveOptions()).toBe(first);
		disposeFirst();
		expect(LocalProtocolHandler.resolveOptions()).toBeUndefined();
		disposeFirst();
		expect(LocalProtocolHandler.resolveOptions()).toBeUndefined();
	});

	it("reset clears direct and owned overrides", () => {
		const owned = { getArtifactsDir: () => "/owned", getSessionId: () => "owned" };
		LocalProtocolHandler.installOverride(owned);
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => "/direct", getSessionId: () => "direct" });

		LocalProtocolHandler.resetOverrideForTests();

		expect(LocalProtocolHandler.resolveOptions()).toBeUndefined();
	});

	it("lists files at local://", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			await fs.mkdir(path.join(artifactsDir, "local"), { recursive: true });
			await Bun.write(path.join(artifactsDir, "local", "handoff.json"), '{"ok":true}');

			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-a",
			});
			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("local://");

			expect(resource.contentType).toBe("text/markdown");
			expect(resource.content).toContain("handoff.json");
		});
	});

	it("reads a local file from session local root", async () => {
		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const localFile = path.join(artifactsDir, "local", "subtasks", "trace.txt");
			await fs.mkdir(path.dirname(localFile), { recursive: true });
			await Bun.write(localFile, "trace");

			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-b",
			});
			const router = InternalUrlRouter.instance();
			const resource = await router.resolve("local://subtasks/trace.txt");

			expect(resource.content).toBe("trace");
			expect(resource.contentType).toBe("text/plain");
		});
	});

	it("blocks path traversal attempts", async () => {
		await withTempDir(async tempDir => {
			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => path.join(tempDir, "artifacts"),
				getSessionId: () => "session-c",
			});
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("local://../secret.txt")).rejects.toThrow(
				"Path traversal (..) is not allowed in local:// URLs",
			);
			await expect(router.resolve("local://%2E%2E/secret.txt")).rejects.toThrow(
				"Path traversal (..) is not allowed in local:// URLs",
			);
		});
	});

	it("uses session id fallback root when artifacts dir is unavailable", async () => {
		const root = resolveLocalRoot({ getSessionId: () => "session-fallback", getArtifactsDir: () => null });
		expect(root).toContain(path.join("gjc-local", "session-fallback"));
		expect(resolveLocalUrlToPath("local://memo.txt", { getSessionId: () => "session-fallback" })).toBe(
			path.join(root, "memo.txt"),
		);
	});

	it("blocks symlink escapes outside local root", async () => {
		if (process.platform === "win32") return;

		await withTempDir(async tempDir => {
			const artifactsDir = path.join(tempDir, "artifacts");
			const localRoot = path.join(artifactsDir, "local");
			const outsideDir = path.join(tempDir, "outside");
			await fs.mkdir(localRoot, { recursive: true });
			await fs.mkdir(outsideDir, { recursive: true });
			await Bun.write(path.join(outsideDir, "secret.txt"), "secret");
			await fs.symlink(outsideDir, path.join(localRoot, "linked"));

			LocalProtocolHandler.setOverride({
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "session-d",
			});
			const router = InternalUrlRouter.instance();
			await expect(router.resolve("local://linked/secret.txt")).rejects.toThrow("local:// URL escapes local root");
		});
	});
});
