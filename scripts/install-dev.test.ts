import { expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";

interface RootManifest {
	scripts: Record<string, string>;
}

test("install:dev builds the native addon, links the source CLI, and enables the repo git hooks", async () => {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const manifest = (await Bun.file(path.join(repoRoot, "package.json")).json()) as RootManifest;

	expect(manifest.scripts["install:dev"]?.split(" && ")).toEqual([
		"bun install",
		"bun run build:native",
		"bun --cwd=packages/coding-agent link",
		"bun --cwd=packages/ai link",
		"bun run dev:link",
		"bun run dev:hooks",
		"bun packages/coding-agent/src/cli.ts setup defaults",
	]);
});

test("pre-push forwards the actual destination, remote branch and pushed object", async () => {
	const temp = await fs.mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "pre-push-hook-"));
	try {
		const callsPath = path.join(temp, "calls.jsonl");
		await fs.writeFile(callsPath, "");
		await fs.writeFile(path.join(temp, "git"), `#!/bin/sh\nprintf '%s\\n' "$MOCK_ROOT"\n`);
		await fs.writeFile(path.join(temp, "bun"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(Number(process.env.VALIDATOR_EXIT));\n`);
		await Promise.all(["git", "bun"].map(name => fs.chmod(path.join(temp, name), 0o755)));
		const hook = path.resolve(import.meta.dir, "../.githooks/pre-push");
		const pushed = "b".repeat(40);
		const previous = "a".repeat(40);
		const zero = "0".repeat(40);
		for (const remote of ["origin", "https://github.com/receiver/project.git"]) {
			await fs.writeFile(callsPath, "");
			const child = Bun.spawn(["bash", hook, remote, "git@github.com:actual/project.git"], {
				env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, MOCK_ROOT: temp, CALLS: callsPath, VALIDATOR_EXIT: "1", GJC_SKIP_PR_PREFLIGHT: "" },
				stdin: new Blob([
					`HEAD ${pushed} refs/heads/destination ${previous}\n`,
					`refs/heads/local ${previous} refs/heads/renamed ${pushed}\n`,
					`refs/heads/dev ${pushed} refs/heads/dev ${previous}\n`,
					`refs/heads/main ${pushed} refs/heads/main ${previous}\n`,
					`(delete) ${zero} refs/heads/deleted ${previous}\n`,
					`refs/tags/v1 ${pushed} refs/tags/v1 ${zero}\n`,
				]), stdout: "pipe", stderr: "pipe",
			});
			const [, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			expect(exitCode).toBe(1);
			const calls = (await fs.readFile(callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
			expect(calls).toEqual([
				[path.join(temp, "scripts/verify-pr-verdict.ts"), "--push-preflight", "destination", pushed, "--push-remote", remote, "--push-url", "git@github.com:actual/project.git", "--repo", temp, "--trusted-root", temp],
				[path.join(temp, "scripts/verify-pr-verdict.ts"), "--push-preflight", "renamed", previous, "--push-remote", remote, "--push-url", "git@github.com:actual/project.git", "--repo", temp, "--trusted-root", temp],
				[path.join(temp, "scripts/verify-pr-verdict.ts"), "--push-preflight", "dev", pushed, "--push-remote", remote, "--push-url", "git@github.com:actual/project.git", "--repo", temp, "--trusted-root", temp],
				[path.join(temp, "scripts/verify-pr-verdict.ts"), "--push-preflight", "main", pushed, "--push-remote", remote, "--push-url", "git@github.com:actual/project.git", "--repo", temp, "--trusted-root", temp],
			]);
		}
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});

test("setup:worktree installs dependencies and builds natives without touching primary-checkout global state", async () => {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const manifest = (await Bun.file(path.join(repoRoot, "package.json")).json()) as RootManifest;
	const script = manifest.scripts["setup:worktree"] ?? "";

	expect(script.split(" && ")).toEqual(["bun install", "bun run build:native"]);
	// install:dev's global-state steps would hijack the primary checkout from a worktree.
	for (const forbidden of ["link", "dev:hooks", "setup defaults"]) {
		expect(script).not.toContain(forbidden);
	}
});
