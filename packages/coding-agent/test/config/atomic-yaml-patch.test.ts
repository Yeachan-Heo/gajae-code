import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import {
	AtomicYamlConflictError,
	type AtomicYamlPatch,
	AtomicYamlReplaceError,
	applyAtomicYamlPatches,
	atomicYamlPathHash,
} from "../../src/config/atomic-yaml-patch";

const temporaryDirectories: string[] = [];

async function configPathForTest(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-atomic-yaml-"));
	temporaryDirectories.push(directory);
	return path.join(directory, "config.yml");
}

async function readYaml(configPath: string): Promise<Record<string, unknown>> {
	const parsed = YAML.parse(await fs.readFile(configPath, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	return parsed as Record<string, unknown>;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("atomic YAML patches", () => {
	test("serializes concurrent writers and preserves unrelated keys", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ external: { keep: true } }, null, 2));

		await Promise.all([
			applyAtomicYamlPatches(configPath, [{ path: "settings.first", op: "set", value: "A" }]),
			applyAtomicYamlPatches(configPath, [{ path: "settings.second", op: "set", value: "B" }]),
		]);

		expect(await readYaml(configPath)).toEqual({
			external: { keep: true },
			settings: { first: "A", second: "B" },
		});
	});

	test("clones caller-owned patch values before the queued write runs", async () => {
		const configPath = await configPathForTest();
		const callerValue = { enabled: false };
		const write = applyAtomicYamlPatches(configPath, [{ path: "feature", op: "set", value: callerValue }]);
		callerValue.enabled = true;

		await write;
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: false } });
	});

	test("returns a hash-only CAS receipt that restores only an unchanged after-state", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ feature: { enabled: false } }, null, 2));

		const receipt = await applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: true }]);
		expect(receipt.revisions).toEqual([
			expect.objectContaining({
				path: "feature.enabled",
				beforeHash: expect.any(String),
				afterHash: expect.any(String),
			}),
		]);
		expect(await receipt.restore()).toMatchObject({ status: "restored" });
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: false } });

		await applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: "newer" }]);
		expect(await receipt.restore()).toEqual({ status: "conflict", paths: ["feature.enabled"] });
	});

	test("does not restore when its receipt is discarded after restore is queued", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ feature: { enabled: false } }, null, 2));
		const receipt = await applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: true }]);

		const restore = receipt.restore();
		receipt.discard();

		expect(await restore).toEqual({ status: "discarded" });
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: true } });
	});

	test("reclaims a stale lock with malformed owner metadata", async () => {
		const configPath = await configPathForTest();
		const lockPath = `${configPath}.lock`;
		await fs.mkdir(lockPath);
		await fs.writeFile(path.join(lockPath, "info"), JSON.stringify({ pid: 0, timestamp: "invalid" }));
		const staleAt = new Date(Date.now() - 20_000);
		await fs.utimes(lockPath, staleAt, staleAt);

		await applyAtomicYamlPatches(configPath, [{ path: "feature.enabled", op: "set", value: true }]);
		expect(await readYaml(configPath)).toEqual({ feature: { enabled: true } });
	});

	test("rejects an expected-hash write after another writer wins", async () => {
		const configPath = await configPathForTest();
		const initial = { modelRoles: { default: "provider/original" } };
		await fs.writeFile(configPath, YAML.stringify(initial, null, 2));
		const expected = { path: "modelRoles.default", hash: atomicYamlPathHash(initial, "modelRoles.default") };
		await applyAtomicYamlPatches(configPath, [
			{ path: "modelRoles.default", op: "set", value: "provider/winner", expected },
		]);
		await expect(
			applyAtomicYamlPatches(configPath, [
				{ path: "modelRoles.default", op: "set", value: "provider/loser", expected },
			]),
		).rejects.toBeInstanceOf(AtomicYamlConflictError);
		expect(await readYaml(configPath)).toEqual({ modelRoles: { default: "provider/winner" } });
	});

	test("does not conflate special numeric values with null in expected hashes", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ feature: { value: null } }, null, 2));
		const expected = {
			path: "feature.value",
			hash: atomicYamlPathHash({ feature: { value: Number.NaN } }, "feature.value"),
		};

		await expect(
			applyAtomicYamlPatches(configPath, [{ path: "feature.value", op: "set", value: "winner", expected }]),
		).rejects.toBeInstanceOf(AtomicYamlConflictError);
		expect(await readYaml(configPath)).toEqual({ feature: { value: null } });
	});

	test("rejects ambiguous undefined set patches", () => {
		const patch = { path: "feature.enabled", op: "set", value: undefined } as unknown as AtomicYamlPatch;
		expect(() => applyAtomicYamlPatches("/tmp/gjc-atomic-invalid.yml", [patch])).toThrow(TypeError);
	});

	test("keeps the old complete file and removes the temp file when rename exhausts", async () => {
		const configPath = await configPathForTest();
		await fs.writeFile(configPath, YAML.stringify({ durable: { value: "old" } }, null, 2));
		const sharingViolation = Object.assign(new Error("sharing violation"), { code: "EPERM" });

		await expect(
			applyAtomicYamlPatches(configPath, [{ path: "durable.value", op: "set", value: "new" }], {
				platform: "win32",
				rename: async () => {
					throw sharingViolation;
				},
				sleep: async () => {},
			}),
		).rejects.toBeInstanceOf(AtomicYamlReplaceError);

		expect(await readYaml(configPath)).toEqual({ durable: { value: "old" } });
		const directoryEntries = await fs.readdir(path.dirname(configPath));
		expect(directoryEntries.filter(entry => entry.endsWith(".tmp"))).toEqual([]);
	});
});
