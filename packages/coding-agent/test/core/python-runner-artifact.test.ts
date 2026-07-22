import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createRunnerScriptCache,
	createRunnerScriptInitializer,
} from "@gajae-code/coding-agent/eval/py/runner-artifact";
import RUNNER_SCRIPT from "../../src/eval/py/runner.py" with { type: "text" };

describe("Python runner artifact", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	it("ignores a prepositioned legacy artifact and coalesces concurrent initialization", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-python-artifact-test-"));
		roots.push(root);
		const legacyDirectory = path.join(root, "gjc-python-runner");
		const sentinelPath = path.join(root, "sentinel.py");
		const sentinelBytes = "legacy sentinel\n";
		await fs.mkdir(legacyDirectory);
		await fs.writeFile(sentinelPath, sentinelBytes);
		const legacyPath = path.join(legacyDirectory, `runner-${Bun.hash(RUNNER_SCRIPT).toString(36)}.py`);
		if (process.platform === "win32") {
			await fs.writeFile(legacyPath, sentinelBytes);
		} else {
			await fs.symlink(sentinelPath, legacyPath);
		}

		const ensureRunnerScript = createRunnerScriptInitializer(root);
		const paths = await Promise.all(Array.from({ length: 8 }, () => ensureRunnerScript()));
		const scriptPath = paths[0];
		const scriptStat = await fs.stat(scriptPath);
		const directoryStat = await fs.stat(path.dirname(scriptPath));

		expect(new Set(paths)).toEqual(new Set([scriptPath]));
		expect(await fs.readFile(scriptPath, "utf8")).toBe(RUNNER_SCRIPT);
		expect(scriptStat.isFile()).toBe(true);
		expect(path.dirname(scriptPath)).not.toBe(legacyDirectory);
		expect(await fs.readFile(legacyPath, "utf8")).toBe(sentinelBytes);
		if (process.platform !== "win32") {
			expect((await fs.lstat(legacyPath)).isSymbolicLink()).toBe(true);
			expect(directoryStat.mode & 0o777).toBe(0o700);
			expect(scriptStat.mode & 0o777).toBe(0o600);
		}
		const privateDirectories = (await fs.readdir(root)).filter(name => name.startsWith("gjc-python-runner-"));
		expect(privateDirectories).toHaveLength(1);
	});
	it("removes the process-private artifact directory during cleanup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-python-artifact-cleanup-"));
		roots.push(root);
		const cache = createRunnerScriptCache(root);
		const scriptPath = await cache.ensureRunnerScript();
		const directory = path.dirname(scriptPath);

		await cache.cleanup();

		await expect(fs.lstat(directory)).rejects.toThrow();
	});

	it("retries after initialization failure instead of memoizing rejection", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-python-artifact-retry-"));
		roots.push(root);
		const missingRoot = path.join(root, "not-created-yet");
		const ensureRunnerScript = createRunnerScriptInitializer(missingRoot);

		await expect(ensureRunnerScript()).rejects.toThrow();
		await fs.mkdir(missingRoot);
		expect((await fs.stat(await ensureRunnerScript())).isFile()).toBe(true);
	});
});
