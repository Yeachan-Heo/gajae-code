import { describe, expect, it } from "bun:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildMemoryEnvironment,
	buildRepositorySnapshot,
	type MemoryGitDependencies,
} from "../../../src/cli/memory/environment";
import type { GitRepository } from "../../../src/utils/git";

const NOW = new Date("2026-07-29T00:00:00.000Z");

function settings(agentDir: string) {
	return { getAgentDir: () => agentDir };
}

function repository(root: string, commonDir: string, gitDir = commonDir): GitRepository {
	return {
		commonDir,
		gitDir,
		gitEntryPath: path.join(root, ".git"),
		headPath: path.join(gitDir, "HEAD"),
		repoRoot: root,
	};
}

function gitDependencies(
	resolved: GitRepository | null,
	remoteUrls: Record<string, string | undefined> = {},
): MemoryGitDependencies {
	return {
		repo: { resolve: async () => resolved },
		remote: {
			list: async () => Object.keys(remoteUrls),
			url: async (_cwd, name) => remoteUrls[name],
		},
	};
}

async function withTempDirectory<T>(run: (root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-environment-"));
	try {
		return await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("memory environment boundary", () => {
	it("canonicalizes a repository snapshot and preserves multiple raw remotes", async () => {
		await withTempDirectory(async root => {
			const worktreeRoot = path.join(root, "worktree");
			const commonDir = path.join(worktreeRoot, ".git");
			await fs.mkdir(commonDir, { recursive: true });
			const snapshot = await buildRepositorySnapshot(
				path.join(worktreeRoot, "nested"),
				gitDependencies(repository(worktreeRoot, commonDir), {
					origin: "git@github.com:acme/widget.git",
					upstream: "https://github.com/acme/widget.git",
				}),
			);

			expect(snapshot).toEqual({
				worktreeRoot: await fs.realpath(worktreeRoot),
				commonDir: await fs.realpath(commonDir),
				isLinkedWorktree: false,
				remotes: [
					{ name: "origin", url: "git@github.com:acme/widget.git" },
					{ name: "upstream", url: "https://github.com/acme/widget.git" },
				],
			});
		});
	});

	it("marks linked worktrees from gitDir versus commonDir", async () => {
		await withTempDirectory(async root => {
			const worktreeRoot = path.join(root, "linked");
			const commonDir = path.join(root, "main", ".git");
			const gitDir = path.join(commonDir, "worktrees", "linked");
			await fs.mkdir(gitDir, { recursive: true });
			const snapshot = await buildRepositorySnapshot(
				worktreeRoot,
				gitDependencies(repository(worktreeRoot, commonDir, gitDir)),
			);

			expect(snapshot?.isLinkedWorktree).toBe(true);
			expect(path.basename(snapshot!.worktreeRoot)).toBe("linked");
			expect(await fs.realpath(path.dirname(snapshot!.worktreeRoot))).toBe(await fs.realpath(root));
			expect(snapshot?.commonDir).toBe(await fs.realpath(commonDir));
		});
	});

	it("returns no repository snapshot outside git", async () => {
		await withTempDirectory(async cwd => {
			const environment = await buildMemoryEnvironment({
				settings: settings(path.join(cwd, "agent")),
				cwd,
				clock: () => NOW,
				git: gitDependencies(null),
				env: {},
			});

			expect(environment.repository).toBeNull();
			expect(environment.sessionId).toBeNull();
		});
	});

	it("resolves flag, payload, then injected env session sources without latest-session probing", async () => {
		await withTempDirectory(async cwd => {
			const base = {
				settings: settings(path.join(cwd, "agent")),
				cwd,
				clock: () => NOW,
				git: gitDependencies(null),
				env: { GJC_SESSION_ID: "from-env" },
			};

			expect(
				(
					await buildMemoryEnvironment({
						...base,
						session: { flagValue: " from-flag ", payloadSessionId: "from-payload" },
					})
				).sessionId,
			).toBe("from-flag");
			expect(
				(
					await buildMemoryEnvironment({
						...base,
						session: { payloadSessionId: "from-payload" },
					})
				).sessionId,
			).toBe("from-payload");
			expect((await buildMemoryEnvironment({ ...base, session: {} })).sessionId).toBe("from-env");
		});
	});

	it("rejects unsafe explicit session ids", async () => {
		await withTempDirectory(async cwd => {
			await expect(
				buildMemoryEnvironment({
					settings: settings(path.join(cwd, "agent")),
					cwd,
					git: gitDependencies(null),
					session: { flagValue: "../outside" },
				}),
			).rejects.toMatchObject({ code: "unsafe_session" });
		});
	});

	it("uses the explicit agent directory for the memory root and deterministic inputs", async () => {
		await withTempDirectory(async cwd => {
			const agentDir = path.join(cwd, "explicit-agent");
			const environment = await buildMemoryEnvironment({
				settings: settings(agentDir),
				cwd,
				clock: () => NOW,
				asOf: "2026-07-29T00:00:01.000Z",
				deterministic: true,
				git: gitDependencies(null),
				env: {},
			});

			expect(environment.memoryRoot).toBe(path.join(agentDir, "memory"));
			expect(environment.now).toBe(NOW);
			expect(environment.asOf).toBe("2026-07-29T00:00:01.000Z");
			expect(environment.deterministic).toBe(true);
		});
	});
});
