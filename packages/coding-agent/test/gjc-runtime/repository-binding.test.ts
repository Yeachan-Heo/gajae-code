import { afterEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertCwdMatchesRepositoryBinding,
	assertPathUnderRepositoryBinding,
	captureRepositoryBinding,
	parseRepositoryBinding,
	REPOSITORY_BINDING_SCHEMA,
	RepositoryBindingError,
	repositoryBindingsMatch,
} from "../../src/gjc-runtime/repository-binding";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fsp.rm(dir, { recursive: true, force: true })));
});

async function initGitRepo(root: string): Promise<void> {
	const run = async (args: string[]) => {
		const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		if (code !== 0) {
			const err = await new Response(proc.stderr).text();
			throw new Error(`git ${args.join(" ")} failed: ${err}`);
		}
	};
	await run(["init"]);
	await run(["config", "user.email", "test@example.com"]);
	await run(["config", "user.name", "Test"]);
	await fsp.writeFile(path.join(root, "README.md"), "hello\n");
	await run(["add", "README.md"]);
	await run(["commit", "-m", "init"]);
}

describe("repository binding (#2901)", () => {
	it("captures and matches the same repository identity", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-repo-bind-"));
		tempRoots.push(root);
		await initGitRepo(root);

		const binding = await captureRepositoryBinding(root);
		expect(binding.schema).toBe(REPOSITORY_BINDING_SCHEMA);
		expect(binding.commonDir).toBeTruthy();
		expect(path.resolve(binding.worktreeRoot)).toBe(path.resolve(root));

		const active = await assertCwdMatchesRepositoryBinding(root, binding);
		expect(repositoryBindingsMatch(active, binding)).toBe(true);
		expect(assertPathUnderRepositoryBinding(binding, "README.md")).toContain("README.md");
	});

	it("fails closed when active cwd is a sibling repository", async () => {
		const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-repo-siblings-"));
		tempRoots.push(parent);
		const left = path.join(parent, "left");
		const right = path.join(parent, "right");
		await fsp.mkdir(left);
		await fsp.mkdir(right);
		await initGitRepo(left);
		await initGitRepo(right);

		const leftBinding = await captureRepositoryBinding(left);
		await expect(assertCwdMatchesRepositoryBinding(right, leftBinding)).rejects.toBeInstanceOf(
			RepositoryBindingError,
		);
		await expect(assertCwdMatchesRepositoryBinding(right, leftBinding)).rejects.toMatchObject({
			code: "identity_mismatch",
		});

		expect(() => assertPathUnderRepositoryBinding(leftBinding, path.join(right, "README.md"))).toThrow(
			/escapes bound repository root/,
		);
	});

	it("rejects relativeSubdir that escapes with ..", () => {
		expect(() =>
			parseRepositoryBinding({
				schema: REPOSITORY_BINDING_SCHEMA,
				worktreeRoot: "/tmp/repo",
				commonDir: "/tmp/repo/.git",
				relativeSubdir: "../sibling",
			}),
		).toThrow(/relativeSubdir/);
	});
});
