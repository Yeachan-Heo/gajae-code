import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { AtomicYamlConflictError, atomicYamlPathHash } from "../src/config/atomic-yaml-patch";

describe("Settings global model role durability", () => {
	let testDir: string;
	let configPath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-settings-global-model-role-"));
		configPath = path.join(testDir, "config.yml");
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("allows exactly one two-process default-role CAS winner without clobbering the loser", async () => {
		const worker = `
			import { applyAtomicYamlPatches } from ${JSON.stringify(new URL("../src/config/atomic-yaml-patch.ts", import.meta.url).href)};
			const [configPath, readyPath, startPath, expectedHash, selector] = process.argv.slice(1);
			await Bun.write(readyPath, "ready");
			while (!(await Bun.file(startPath).exists())) await Bun.sleep(1);
			try {
				await applyAtomicYamlPatches(configPath, [{ path: "modelRoles.default", op: "set", value: selector, expected: { path: "modelRoles.default", hash: expectedHash } }]);
				console.log(JSON.stringify({ status: "winner", selector }));
			} catch (error) {
				console.log(JSON.stringify({ status: "loser", name: error instanceof Error ? error.name : "unknown", code: error && typeof error === "object" ? error.code : undefined }));
			}
		`;
		const initial = { modelRoles: { default: "provider/original:low" } };
		await Bun.write(configPath, YAML.stringify(initial));
		const expectedHash = atomicYamlPathHash(initial, "modelRoles.default");
		const startPath = path.join(testDir, "start");
		const workers = ["provider/first:low", "provider/second:high"].map((selector, index) =>
			Bun.spawn(
				[
					process.execPath,
					"-e",
					worker,
					configPath,
					path.join(testDir, `ready-${index}`),
					startPath,
					expectedHash,
					selector,
				],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			),
		);
		while (
			!(await Bun.file(path.join(testDir, "ready-0")).exists()) ||
			!(await Bun.file(path.join(testDir, "ready-1")).exists())
		) {
			await Bun.sleep(1);
		}
		await Bun.write(startPath, "go");
		const results = await Promise.all(
			workers.map(async child => {
				expect(await child.exited).toBe(0);
				return JSON.parse(await new Response(child.stdout).text()) as {
					status: string;
					selector?: string;
					name?: string;
					code?: string;
				};
			}),
		);
		const winner = results.find(result => result.status === "winner");
		if (!winner?.selector) throw new Error("Expected a winning selector.");
		expect(results.filter(result => result.status === "winner")).toHaveLength(1);
		expect(results.filter(result => result.status === "loser")).toEqual([
			expect.objectContaining({ name: AtomicYamlConflictError.name, code: "ATOMIC_YAML_CONFLICT" }),
		]);
		expect(
			(YAML.parse(await Bun.file(configPath).text()) as { modelRoles: { default: string } }).modelRoles.default,
		).toBe(winner.selector);
	});
});
