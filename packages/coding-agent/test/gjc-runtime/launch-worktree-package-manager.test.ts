import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ensureReusableNodeModules,
	ensureReusableNodeModulesCancellable,
} from "@gajae-code/coding-agent/gjc-runtime/launch-worktree";
import fc from "fast-check";

const cleanupRoots: string[] = [];

afterEach(() => {
	for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(packageManager: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-pm-"));
	cleanupRoots.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"], packageManager }),
	);
	return root;
}

function stubWhich(present: string | null) {
	return spyOn(Bun, "which").mockImplementation((bin: string) => {
		if (present !== null && (bin === "pnpm" || bin === "npm")) return present;
		return null;
	});
}

function stubSpawn(calls: string[][]) {
	return spyOn(Bun, "spawnSync").mockImplementation(((command: string[], options?: { cwd?: string }) => {
		calls.push([...command]);
		if (options?.cwd) fs.mkdirSync(path.join(options.cwd, "node_modules"), { recursive: true });
		return {
			exitCode: 0,
			stdout: Buffer.from(""),
			stderr: Buffer.from(""),
		};
	}) as unknown as typeof Bun.spawnSync);
}

function withMissingManager<T>(body: (calls: string[][]) => T): T {
	const calls: string[][] = [];
	const whichSpy = stubWhich(null);
	const spawnSpy = stubSpawn(calls);
	try {
		return body(calls);
	} finally {
		whichSpy.mockRestore();
		spawnSpy.mockRestore();
	}
}

describe("worktree packageManager version", () => {
	it("refuses a packageManager alias before bun x runs", () => {
		const specs = [
			"pnpm@npm:evil@1.0.0",
			"pnpm@file:../evil",
			"npm@https://evil.example/pkg.tgz",
			"pnpm@1.2.3#npm:evil@1.0.0",
			"pnpm@latest",
			"npm@^11.5.2",
			"pnpm@1.2.3 && curl",
		];
		for (const packageManager of specs) {
			const manager = packageManager.slice(0, packageManager.indexOf("@"));
			withMissingManager(calls => {
				const root = workspace(packageManager);
				expect(() => ensureReusableNodeModules(root, root)).toThrow(
					new RegExp(`worktree_dependency_manager_version_invalid:${manager}`),
				);
				expect(calls).toEqual([]);
			});
		}
	});

	it("refuses an overlong packageManager version before bun x", () => {
		withMissingManager(calls => {
			const root = workspace(`pnpm@${"a".repeat(4000)}`);
			expect(() => ensureReusableNodeModules(root, root)).toThrow(
				/worktree_dependency_manager_version_invalid:pnpm/,
			);
			expect(calls).toEqual([]);
		});
	});

	it("refuses an npm alias before the cancellable install spawn", async () => {
		const root = workspace("pnpm@npm:evil@1.0.0");
		const whichSpy = stubWhich(null);
		const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("unexpected spawn");
		});
		try {
			await expect(ensureReusableNodeModulesCancellable(root, root)).rejects.toThrow(
				/worktree_dependency_manager_version_invalid:pnpm/,
			);
			expect(spawnSpy).not.toHaveBeenCalled();
		} finally {
			whichSpy.mockRestore();
			spawnSpy.mockRestore();
		}
	});

	it("still allows an exact pnpm version through bun x", () => {
		withMissingManager(calls => {
			const root = workspace("pnpm@10.14.0");
			expect(ensureReusableNodeModules(root, root)).toBe("present");
			expect(calls).toEqual([["bun", "x", "pnpm@10.14.0", "install", "--frozen-lockfile"]]);
		});
	});

	it("still allows an exact npm version through bun x", () => {
		withMissingManager(calls => {
			const root = workspace("npm@11.5.2");
			expect(ensureReusableNodeModules(root, root)).toBe("present");
			expect(calls).toEqual([["bun", "x", "npm@11.5.2", "ci"]]);
		});
	});

	it("still allows a corepack hash, prerelease, and v prefix through bun x", () => {
		for (const version of ["9.15.0+sha224.953c8233", "10.0.0-beta.1", "v10.14.0"]) {
			withMissingManager(calls => {
				const root = workspace(`pnpm@${version}`);
				expect(ensureReusableNodeModules(root, root)).toBe("present");
				expect(calls).toEqual([["bun", "x", `pnpm@${version}`, "install", "--frozen-lockfile"]]);
			});
		}
	});

	it("still allows a local pnpm install when the declared version is an alias", () => {
		const calls: string[][] = [];
		const root = workspace("pnpm@npm:evil@1.0.0");
		const whichSpy = stubWhich("local-pnpm");
		const spawnSpy = stubSpawn(calls);
		try {
			expect(ensureReusableNodeModules(root, root)).toBe("present");
			expect(calls).toEqual([["pnpm", "install", "--frozen-lockfile"]]);
		} finally {
			whichSpy.mockRestore();
			spawnSpy.mockRestore();
		}
	});

	it("still allows bun install when the declared version is an alias", () => {
		withMissingManager(calls => {
			const root = workspace("bun@npm:evil@1.0.0");
			expect(ensureReusableNodeModules(root, root)).toBe("present");
			expect(calls).toEqual([["bun", "install", "--frozen-lockfile"]]);
		});
	});

	it("keeps the unavailable manager error when the version is omitted", () => {
		withMissingManager(calls => {
			const root = workspace("pnpm");
			expect(() => ensureReusableNodeModules(root, root)).toThrow(/worktree_dependency_manager_unavailable:pnpm/);
			expect(calls).toEqual([]);
		});
	});

	it("property packageManager alias versions are not executed seed 110917", () => {
		const aliasVersion = fc.string({ minLength: 1, maxLength: 40 }).map(value => {
			const trimmed = value.trim() || "pkg";
			return trimmed.includes(":") ? trimmed : `npm:${trimmed}`;
		});
		fc.assert(
			fc.property(aliasVersion, version => {
				withMissingManager(calls => {
					const root = workspace(`pnpm@${version}`);
					expect(() => ensureReusableNodeModules(root, root)).toThrow(
						/worktree_dependency_manager_version_invalid:pnpm/,
					);
					expect(calls).toEqual([]);
				});
			}),
			{ seed: 110917, numRuns: 64 },
		);
	});

	it("property still allows exact packageManager versions to round-trip seed 110918", () => {
		const exactVersion = fc
			.record({
				major: fc.integer({ min: 0, max: 40 }),
				minor: fc.integer({ min: 0, max: 40 }),
				patch: fc.integer({ min: 0, max: 40 }),
				pre: fc.constantFrom("", "-beta.1", "-rc.0", "-next.2"),
				build: fc.constantFrom("", "+sha224.abc123", "+build.1"),
				prefix: fc.constantFrom("", "v"),
			})
			.map(value => `${value.prefix}${value.major}.${value.minor}.${value.patch}${value.pre}${value.build}`);
		fc.assert(
			fc.property(exactVersion, version => {
				withMissingManager(first => {
					const root = workspace(`pnpm@${version}`);
					expect(ensureReusableNodeModules(root, root)).toBe("present");
					expect(ensureReusableNodeModules(root, root)).toBe("present");
					const expected = ["bun", "x", `pnpm@${version}`, "install", "--frozen-lockfile"];
					expect(first).toEqual([expected, expected]);
				});
			}),
			{ seed: 110918, numRuns: 64 },
		);
	});
});
