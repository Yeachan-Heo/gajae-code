import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const tempRoots: string[] = [];

async function makeExecutable(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

describe("dev:link", () => {
	test("fails when a shadow gjc earlier on PATH would make smoke-test validate the wrong command", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dev-link-shadow-"));
		tempRoots.push(root);
		const shadowDir = path.join(root, "shadow-bin");
		const targetDir = path.join(root, "managed-bin");
		await makeExecutable(
			path.join(shadowDir, "gjc"),
			`#!/usr/bin/env sh\nif [ "$1" = "--smoke-test" ]; then echo "smoke-test: ok"; exit 0; fi\necho shadow\nexit 0\n`,
		);

		const result = Bun.spawnSync([process.execPath, "scripts/dev-link.ts"], {
			env: {
				...process.env,
				GJC_DEV_LINK_DIR: targetDir,
				PATH: `${shadowDir}:${targetDir}`,
			},
			stderr: "pipe",
			stdout: "pipe",
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.toString()).toContain(`Linked ${path.join(targetDir, "gjc")}`);
		expect(result.stderr.toString()).toContain("still resolves to a different command earlier on PATH");
		expect(result.stderr.toString()).toContain(path.join(shadowDir, "gjc"));
	});
});
