import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const fixtureRoot = path.join(import.meta.dir, "fixtures", `.glob-cache-budget-${crypto.randomUUID()}`);

import { FileType, glob, invalidateFsScanCache } from "../native/index.js";

beforeAll(async () => {
	await fs.mkdir(fixtureRoot, { recursive: true });
});

afterAll(async () => {
	await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("walker scan-cache policy", () => {
	it("rejects a scan that exceeds the configured per-scan entry budget", async () => {
		const root = path.join(fixtureRoot, "entry-budget");
		await fs.mkdir(root, { recursive: true });
		for (const name of ["a.txt", "b.txt", "c.txt"]) {
			await fs.writeFile(path.join(root, name), `${name}\n`);
		}

		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "glob-cache-budget-child.ts")], {
			cwd: import.meta.dir,
			env: {
				...process.env,
				FS_SCAN_MAX_ENTRIES: "2",
				FS_SCAN_CACHE_TTL_MS: "60000",
				GLOB_CACHE_BUDGET_ROOT: root,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	it("invalidates a cached snapshot after a mutation", async () => {
		const root = path.join(fixtureRoot, "mutation");
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(path.join(root, "before.txt"), "before\n");
		const run = async () => {
			const result = await glob({
				path: root,
				pattern: "**/*.txt",
				recursive: true,
				hidden: true,
				gitignore: false,
				cache: true,
				fileType: FileType.File,
			});
			return result.matches.map(entry => entry.path).sort();
		};

		const before = await run();
		await fs.writeFile(path.join(root, "after.txt"), "after\n");
		const stale = await run();
		invalidateFsScanCache(path.join(root, "after.txt"));
		const fresh = await run();

		expect(before).toEqual(["before.txt"]);
		expect(stale).toEqual(["before.txt"]);
		expect(fresh).toEqual(["after.txt", "before.txt"]);
	});
});
