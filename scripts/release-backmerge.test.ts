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
	test("merges a diverged dev, resolves the manifest, and lands a conventional commit", async () => {
		const { origin, work } = await backmergeFixture();

		const outcome = await backmergeReleaseIntoDev("0.18.7", { repoDir: work });
		expect(outcome.action).toBe("merged");

		// The released version wins while dev's digests and its own work survive.
		const merged = JSON.parse(await git(origin, "show", `dev:${BACKMERGE_CONFLICT_PATH}`)) as Record<string, unknown>;
		expect(merged).toEqual({
			schema: "gjc.diagnostic-artifact",
			version: "0.18.7",
			artifacts: { "pi_natives.darwin-arm64.node": "dev-digest" },
		});
		expect(await git(origin, "show", "dev:released.txt")).toBe("released\n");
		expect(await git(origin, "show", "dev:dev-only.txt")).toBe("dev\n");

		// The generated commit carries the required conventional subject and why body.
		expect((await git(origin, "log", "-1", "--format=%s", "dev")).trim()).toBe("chore(release): sync the v0.18.7 release into dev");
		expect(await git(origin, "log", "-1", "--format=%b", "dev")).toContain("fast-forward");

		// dev now contains main, so a repeat run has nothing to do.
		const repeat = await backmergeReleaseIntoDev("0.18.7", { repoDir: work });
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

		const outcome = await backmergeReleaseIntoDev("0.18.7", { repoDir: work });

		expect(outcome.action).toBe("blocked");
		expect(outcome.detail).toContain("no artifacts map on dev");
		expect(await git(origin, "rev-parse", "dev")).toBe(before);
	});
});
