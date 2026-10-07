import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BACKMERGE_CONFLICT_PATH,
	backmergeReleaseIntoDev,
	classifyBackmergePushFailure,
	resolveDiagnosticArtifactBackmerge,
} from "./release";

const DEV = `{
  "schema": "gjc.diagnostic-artifact",
  "version": "0.18.6",
  "artifacts": {
    "pi_natives.darwin-arm64.node": "dev-digest"
  }
}
`;

const MAIN = `{
  "schema": "gjc.diagnostic-artifact",
  "version": "0.18.7",
  "artifacts": {
    "pi_natives.darwin-arm64.node": "main-digest"
  }
}
`;

describe("backmerge conflict resolution", () => {
	test("keeps the released version and dev's artifact digests", () => {
		const resolved = JSON.parse(resolveDiagnosticArtifactBackmerge(DEV, MAIN)) as Record<string, unknown>;
		expect(resolved).toEqual({
			schema: "gjc.diagnostic-artifact",
			version: "0.18.7",
			artifacts: { "pi_natives.darwin-arm64.node": "dev-digest" },
		});
		expect(resolveDiagnosticArtifactBackmerge(DEV, MAIN).endsWith("\n")).toBe(true);
	});
	test("keeps top-level manifest fields it does not know about", () => {
		// The manifest churns every release; a field added later must survive the resolution.
		const future = `{"schema":"gjc.diagnostic-artifact","artifacts":{},"builtAt":"2026-01-01T00:00:00Z"}`;
		const resolved = JSON.parse(resolveDiagnosticArtifactBackmerge(future, MAIN)) as Record<string, unknown>;
		expect(resolved.builtAt).toBe("2026-01-01T00:00:00Z");
		expect(resolved.version).toBe("0.18.7");
		expect(resolved.schema).toBe("gjc.diagnostic-artifact");
	});

	test("fails closed on any manifest field the resolution depends on", () => {
		expect(() => resolveDiagnosticArtifactBackmerge(DEV, `{"artifacts":{}}`)).toThrow(
			new RegExp(`${BACKMERGE_CONFLICT_PATH} has no string version on main`),
		);
		expect(() => resolveDiagnosticArtifactBackmerge(`{"version":"0.18.6"}`, MAIN)).toThrow(/no string schema on dev/);
		expect(() => resolveDiagnosticArtifactBackmerge(`{"schema":"gjc.diagnostic-artifact"}`, MAIN)).toThrow(
			/no artifacts map on dev/,
		);
		// An array is `typeof "object"` too, but it is not the artifacts map.
		expect(() =>
			resolveDiagnosticArtifactBackmerge(`{"schema":"gjc.diagnostic-artifact","artifacts":[]}`, MAIN),
		).toThrow(/no artifacts map on dev/);
	});
});

describe("backmerge push rejection", () => {
	test("retries only when dev moved under the merge", () => {
		expect(classifyBackmergePushFailure(" ! [rejected]        HEAD -> dev (fetch first)")).toBe("retry");
		expect(classifyBackmergePushFailure(" ! [rejected]        HEAD -> dev (non-fast-forward)")).toBe("retry");
	});

	test("reports a terminal refusal instead of burning the remaining attempts", () => {
		// A protected-branch or permission rejection cannot succeed on a retry.
		expect(
			classifyBackmergePushFailure(
				"remote: error: GH006: Protected branch update failed for refs/heads/dev.\n ! [remote rejected] HEAD -> dev (protected branch hook declined)",
			),
		).toBe("blocked");
		expect(classifyBackmergePushFailure("fatal: Authentication failed for 'https://github.com/x/y.git/'")).toBe("blocked");
		expect(classifyBackmergePushFailure("")).toBe("blocked");
	});
});

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

type GitResult = { exitCode: number; stdout: string; stderr: string };

async function gitCommand(cwd: string, args: readonly string[]): Promise<GitResult> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await gitCommand(cwd, args);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
	return result.stdout;
}

function manifest(version: string, digest: string): string {
	return `{\n  "schema": "gjc.diagnostic-artifact",\n  "version": "${version}",\n  "artifacts": {\n    "pi_natives.darwin-arm64.node": "${digest}"\n  }\n}\n`;
}

/**
 * A bare origin whose `main` ships a release that `dev` has not seen, with a diverged
 * build-digest manifest — the shape every release backmerge has to merge.
 */
async function backmergeFixture(options: { devManifest?: string; secondConflict?: boolean } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-backmerge-e2e-"));
	tempRoots.push(root);
	const origin = path.join(root, "origin.git");
	const work = path.join(root, "work");
	const readme = path.join(work, "README.md");
	await git(root, "init", "--bare", "--initial-branch=main", origin);
	await git(root, "clone", origin, work);
	await git(work, "config", "user.email", "release@example.com");
	await git(work, "config", "user.name", "Release");
	// A signing hook would fail the fixture commits on a machine with global signing on.
	await git(work, "config", "commit.gpgsign", "false");
	await fs.mkdir(path.join(work, path.dirname(BACKMERGE_CONFLICT_PATH)), { recursive: true });
	await Bun.write(path.join(work, BACKMERGE_CONFLICT_PATH), manifest("0.18.6", "base-digest"));
	await Bun.write(readme, "base\n");
	await git(work, "add", "-A");
	await git(work, "commit", "-m", "chore: base");
	await git(work, "push", "origin", "main");

	// dev diverges first, so the release commit main ships afterwards is genuinely new to it.
	await git(work, "checkout", "-b", "dev");
	await Bun.write(path.join(work, BACKMERGE_CONFLICT_PATH), options.devManifest ?? manifest("0.18.6", "dev-digest"));
	if (options.secondConflict === true) await Bun.write(readme, "dev\n");
	await Bun.write(path.join(work, "dev-only.txt"), "dev\n");
	await git(work, "add", "-A");
	await git(work, "commit", "-m", "feat: dev work");
	await git(work, "push", "origin", "dev");

	await git(work, "checkout", "main");
	await Bun.write(path.join(work, BACKMERGE_CONFLICT_PATH), manifest("0.18.7", "main-digest"));
	if (options.secondConflict === true) await Bun.write(readme, "main\n");
	await Bun.write(path.join(work, "released.txt"), "released\n");
	await git(work, "add", "-A");
	await git(work, "commit", "-m", "chore: release 0.18.7");
	await git(work, "push", "origin", "main");
	return { origin, work };
}

describe("backmerge orchestration", () => {
	test("creates a backmerge branch and PR for a diverged dev", async () => {
		const { origin, work } = await backmergeFixture();
		
		// Mock gh to simulate successful PR creation
		let ghCalls: string[][] = [];
		const mockGh = async (args: readonly string[]) => {
			ghCalls.push([...args]);
			if (args[0] === "pr" && args[1] === "create") {
				// Simulate successful PR creation output
				const prUrl = "https://github.com/Yeachan-Heo/gajae-code/pull/9999";
				return {
					exitCode: 0,
					stdout: new TextEncoder().encode(prUrl),
					stderr: new Uint8Array(),
				};
			}
			return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
		};

		const outcome = await backmergeReleaseIntoDev("0.18.7", { repoDir: work, gh: mockGh });
		expect(outcome.action).toBe("pr-opened");
		if (outcome.action === "pr-opened") {
			expect(outcome.prUrl).toContain("github.com");
			expect(outcome.branch).toBe("refs/heads/backmerge/0.18.7");
		}

		// Verify gh pr create was called with the backmerge branch
		const prCreateCall = ghCalls.find(args => args[0] === "pr" && args[1] === "create");
		expect(prCreateCall).toBeDefined();
		if (prCreateCall) {
			expect(prCreateCall.join(" ")).toContain("backmerge/0.18.7");
		}

		// The backmerge branch (not dev!) contains the merged and resolved content
		// Fetch to ensure we see the backmerge branch
		await git(work, "fetch", "origin");
		const merged = JSON.parse(await git(work, "show", `origin/backmerge/0.18.7:${BACKMERGE_CONFLICT_PATH}`)) as Record<string, unknown>;
		expect(merged).toEqual({
			schema: "gjc.diagnostic-artifact",
			version: "0.18.7",
			artifacts: { "pi_natives.darwin-arm64.node": "dev-digest" },
		});
		expect(await git(work, "show", "origin/backmerge/0.18.7:released.txt")).toBe("released\n");
		expect(await git(work, "show", "origin/backmerge/0.18.7:dev-only.txt")).toBe("dev\n");

		// The generated commit carries the required conventional subject and why body.
		expect((await git(work, "log", "-1", "--format=%s", "origin/backmerge/0.18.7")).trim()).toBe("chore(release): sync the v0.18.7 release into dev");
		expect(await git(work, "log", "-1", "--format=%b", "origin/backmerge/0.18.7")).toContain("fast-forward");

		// After the PR is merged (simulated by updating dev), a repeat run would have nothing to do.
		// For now, manually merge the backmerge branch into dev to simulate PR merge
		await git(work, "fetch", "origin");
		await git(work, "checkout", "dev");
		await git(work, "merge", "origin/backmerge/0.18.7");
		await git(work, "push", "origin", "dev");

		// Now dev contains main, so a repeat run has nothing to do.
		const repeat = await backmergeReleaseIntoDev("0.18.7", { repoDir: work, gh: mockGh });
		expect(repeat.action).toBe("skipped");

		// The throwaway worktree is deregistered rather than left behind.
		const registered = (await git(work, "worktree", "list", "--porcelain"))
			.split("\n")
			.filter(line => line.startsWith("worktree "));
		expect(registered).toHaveLength(1);
	});

	test("fails closed on a conflict the resolver does not own and leaves dev untouched", async () => {
		const { origin, work } = await backmergeFixture({ secondConflict: true });
		const before = await git(origin, "rev-parse", "dev");

		const outcome = await backmergeReleaseIntoDev("0.18.7", { repoDir: work });

		expect(outcome.action).toBe("blocked");
		expect(outcome.detail).toContain("unexpected conflict");
		expect(await git(origin, "rev-parse", "dev")).toBe(before);
	});

	test("fails closed when dev's own manifest cannot be resolved", async () => {
		const { origin, work } = await backmergeFixture({
			devManifest: '{\n  "schema": "gjc.diagnostic-artifact",\n  "version": "0.18.6"\n}\n',
		});
		const before = await git(origin, "rev-parse", "dev");

		const mockGh = async () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
		const outcome = await backmergeReleaseIntoDev("0.18.7", { repoDir: work, gh: mockGh });

		expect(outcome.action).toBe("blocked");
		expect(outcome.detail).toContain("no artifacts map on dev");
		expect(await git(origin, "rev-parse", "dev")).toBe(before);
	});

	test("detects existing PR and returns pr-opened without error", async () => {
		const { origin, work } = await backmergeFixture();

		// Mock gh to simulate PR already exists error, then successful query
		let callCount = 0;
		const mockGh = async (args: readonly string[]) => {
			if (args[0] === "pr" && args[1] === "create") {
				// Simulate PR already exists error
				return {
					exitCode: 1,
					stdout: new Uint8Array(),
					stderr: new TextEncoder().encode("pull request already exists for backmerge/0.18.7"),
				};
			}
			if (args[0] === "pr" && args[1] === "list") {
				// Simulate PR list query returning the existing PR
				return {
					exitCode: 0,
					stdout: new TextEncoder().encode(JSON.stringify([{ url: "https://github.com/Yeachan-Heo/gajae-code/pull/1000" }])),
					stderr: new Uint8Array(),
				};
			}
			return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
		};

		const outcome = await backmergeReleaseIntoDev("0.18.7", { repoDir: work, gh: mockGh });
		expect(outcome.action).toBe("pr-opened");
		if (outcome.action === "pr-opened") {
			expect(outcome.prUrl).toContain("github.com");
		}
	});

	test("reports gh PR creation failure as blocked", async () => {
		const { origin, work } = await backmergeFixture();

		// Mock gh to simulate genuine failure
		const mockGh = async (args: readonly string[]) => {
			if (args[0] === "pr" && args[1] === "create") {
				return {
					exitCode: 1,
					stdout: new Uint8Array(),
					stderr: new TextEncoder().encode("fatal: Authentication failed for 'https://github.com/Yeachan-Heo/gajae-code.git/'"),
				};
			}
			return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
		};

		const outcome = await backmergeReleaseIntoDev("0.18.7", { repoDir: work, gh: mockGh });
		expect(outcome.action).toBe("blocked");
		expect(outcome.detail).toContain("failed to create backmerge PR");
	});

	test("never pushes to dev directly", async () => {
		const { origin, work } = await backmergeFixture();

		// Verify by checking git refs - dev should not be updated yet (only backmerge branch)
		const mockGh = async (args: readonly string[]) => {
			if (args[0] === "pr" && args[1] === "create") {
				return {
					exitCode: 0,
					stdout: new TextEncoder().encode("https://github.com/Yeachan-Heo/gajae-code/pull/9999"),
					stderr: new Uint8Array(),
				};
			}
			return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
		};

		const devBefore = await git(origin, "rev-parse", "dev");
		await backmergeReleaseIntoDev("0.18.7", { repoDir: work, gh: mockGh });
		const devAfter = await git(origin, "rev-parse", "dev");

		// dev should be unchanged - only backmerge branch exists
		expect(devAfter).toBe(devBefore);

		// Verify backmerge branch exists
		const branches = await git(work, "branch", "-r");
		expect(branches).toContain("origin/backmerge/0.18.7");
	});
});
