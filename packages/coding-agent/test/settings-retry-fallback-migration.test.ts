import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "@gajae-code/coding-agent/config/file-lock";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { logger } from "@gajae-code/utils";
import { YAML } from "bun";

let root = "";

async function writeGlobal(value: Record<string, unknown>): Promise<void> {
	await fs.mkdir(root, { recursive: true });
	await Bun.write(path.join(root, "config.yml"), YAML.stringify(value, null, 2));
}

async function readGlobal(): Promise<Record<string, unknown>> {
	return YAML.parse(await Bun.file(path.join(root, "config.yml")).text()) as Record<string, unknown>;
}

async function readGlobalFallbackChains(): Promise<unknown> {
	const retry = (await readGlobal()).retry;
	return retry && typeof retry === "object" && !Array.isArray(retry)
		? (retry as Record<string, unknown>).fallbackChains
		: undefined;
}

beforeEach(async () => {
	resetSettingsForTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-retry-fallback-migration-"));
});

afterEach(async () => {
	resetSettingsForTest();
	await fs.rm(root, { recursive: true, force: true });
});

describe("retry.fallbackChains migration", () => {
	test("migrates a global legacy tail after its effective primary and removes legacy keys", async () => {
		await writeGlobal({
			modelRoles: { default: "global/head" },
			retry: { fallbackChains: { default: ["global/tail", "global/head", "global/tail-2"] } },
		});

		const settings = await Settings.init({ agentDir: root, cwd: root });
		expect(settings.getModelRole("default")).toEqual(["global/head", "global/tail", "global/tail-2"]);
		expect((await readGlobal()).retry).toBeUndefined();
	});

	test("normalizes a project-owned legacy tail only in memory", async () => {
		await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
		await Bun.write(
			path.join(root, ".cursor", "settings.json"),
			JSON.stringify({
				modelRoles: { default: "project/head" },
				retry: { fallbackChains: { default: ["project/tail"] } },
			}),
		);

		const settings = await Settings.init({ agentDir: root, cwd: root });
		expect(settings.getModelRole("default")).toEqual(["project/head", "project/tail"]);
	});

	test("retains a global legacy tail when a project head owns the migrated chain across reloads", async () => {
		await writeGlobal({
			modelRoles: { default: "global/head" },
			retry: { fallbackChains: { default: ["global/tail"] } },
		});
		await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
		await Bun.write(
			path.join(root, ".cursor", "settings.json"),
			JSON.stringify({ modelRoles: { default: "project/head" } }),
		);

		const first = await Settings.init({ agentDir: root, cwd: root });
		expect(first.getModelRole("default")).toEqual(["project/head", "global/tail"]);
		expect(await readGlobalFallbackChains()).toEqual({ default: ["global/tail"] });

		resetSettingsForTest();
		const second = await Settings.init({ agentDir: root, cwd: root });
		expect(second.getModelRole("default")).toEqual(["project/head", "global/tail"]);
		expect(await readGlobalFallbackChains()).toEqual({ default: ["global/tail"] });
	});

	test("retains a global legacy tail when runtime overrides own the migrated chain across reloads", async () => {
		await writeGlobal({
			modelRoles: { default: "global/head" },
			retry: { fallbackChains: { default: ["global/tail"] } },
		});
		const overrides = {
			modelRoles: { default: "override/head" },
		} as never;

		const first = await Settings.init({ agentDir: root, cwd: root, overrides });
		expect(first.getModelRole("default")).toEqual(["override/head", "global/tail"]);
		expect((await readGlobal()).modelRoles).toEqual({ default: "global/head" });
		expect(await readGlobalFallbackChains()).toEqual({ default: ["global/tail"] });

		resetSettingsForTest();
		const second = await Settings.init({ agentDir: root, cwd: root, overrides });
		expect(second.getModelRole("default")).toEqual(["override/head", "global/tail"]);
		expect(await readGlobalFallbackChains()).toEqual({ default: ["global/tail"] });
	});

	test("normalizes the cloned cwd after loading its project settings", async () => {
		const clonedCwd = path.join(root, "cloned");
		await writeGlobal({
			retry: { fallbackChains: { default: ["global/tail"] } },
		});
		await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
		await Bun.write(
			path.join(root, ".cursor", "settings.json"),
			JSON.stringify({ modelRoles: { default: "first/head" } }),
		);
		await fs.mkdir(path.join(clonedCwd, ".cursor"), { recursive: true });
		await Bun.write(
			path.join(clonedCwd, ".cursor", "settings.json"),
			JSON.stringify({ modelRoles: { default: "cloned/head" } }),
		);

		const settings = await Settings.init({ agentDir: root, cwd: root });
		expect(settings.getModelRole("default")).toEqual(["first/head", "global/tail"]);
		const cloned = await settings.cloneForCwd(clonedCwd);
		expect(cloned.getModelRole("default")).toEqual(["cloned/head", "global/tail"]);
	});

	test("is idempotent across reloads", async () => {
		await writeGlobal({
			modelRoles: { default: "global/head" },
			retry: { fallbackChains: { default: ["global/tail"] } },
		});
		const first = await Settings.init({ agentDir: root, cwd: root });
		expect(first.getModelRole("default")).toEqual(["global/head", "global/tail"]);
		const firstFile = await Bun.file(path.join(root, "config.yml")).text();

		resetSettingsForTest();
		const second = await Settings.init({ agentDir: root, cwd: root });
		expect(second.getModelRole("default")).toEqual(["global/head", "global/tail"]);
		expect(await Bun.file(path.join(root, "config.yml")).text()).toBe(firstFile);
	});

	test("does not replay stale modelRoles after a competing writer completes the migration", async () => {
		const configPath = path.join(root, "config.yml");
		await writeGlobal({
			modelRoles: { default: "legacy/head" },
			retry: { fallbackChains: { default: ["legacy/tail"] } },
		});

		let writerA: Promise<Settings>;
		await withFileLock(configPath, async () => {
			writerA = Settings.init({ agentDir: root, cwd: root });
			// Let writer A load the legacy snapshot and block attempting its writeback.
			await Bun.sleep(100);
			await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "writer-b/newer" } }, null, 2));
		});

		await writerA!;
		expect((await readGlobal()).modelRoles).toEqual({ default: "writer-b/newer" });
		expect(await readGlobalFallbackChains()).toBeUndefined();
	});

	test("warns once for unmigratable entries while suppressing all legacy keys", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		await writeGlobal({
			modelRoles: { default: "global/head" },
			retry: { fallbackChains: { default: [123] } },
		});

		const settings = await Settings.init({ agentDir: root, cwd: root });
		expect(settings.getModelRole("default")).toBe("global/head");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be migrated"));
		expect((await readGlobal()).retry).toBeUndefined();
	});

	test("does not rewrite a config from a newer schema version", async () => {
		const futureConfig = {
			configSchemaVersion: 2,
			modelRoles: { default: "future/head" },
			retry: { fallbackChains: { default: ["future/tail"] } },
		};
		await writeGlobal(futureConfig);

		const settings = await Settings.init({ agentDir: root, cwd: root });
		expect(settings.getModelRole("default")).toBe("future/head");
		await settings.cloneForCwd(root);
		expect(await readGlobal()).toEqual(futureConfig);
	});
});

describe("post-migration ordinary saves", () => {
	test("persists a later modelRoles change after the initial migration flush", async () => {
		await writeGlobal({
			modelRoles: { default: "global/head" },
			retry: { fallbackChains: { default: ["global/tail"] } },
		});

		const settings = await Settings.init({ agentDir: root, cwd: root });
		expect(settings.getModelRole("default")).toEqual(["global/head", "global/tail"]);

		settings.set("modelRoles", { default: "user/new-choice" });
		await settings.flush();

		const persisted = await readGlobal();
		expect((persisted.modelRoles as Record<string, unknown>).default).toBe("user/new-choice");
	});
});

describe("selector record load-time sanitation", () => {
	test("replaces whole-record malformed selector settings on load", async () => {
		await writeGlobal({
			modelRoles: null,
			task: { agentModelOverrides: ["not", "a", "record"] },
		});

		const settings = await Settings.init({ agentDir: root, cwd: root });
		expect(settings.get("modelRoles")).toEqual({});
		expect(settings.get("task.agentModelOverrides")).toEqual({});
	});

	test("drops invalid members while keeping valid selector values on load", async () => {
		await writeGlobal({
			modelRoles: { default: "a/b", broken: {}, empty: [], blank: "  " },
			task: { agentModelOverrides: { executor: ["a/b", "c/d"], bad: 42 } },
		});

		const settings = await Settings.init({ agentDir: root, cwd: root });
		expect(settings.get("modelRoles")).toEqual({ default: "a/b" });
		expect(settings.get("task.agentModelOverrides")).toEqual({ executor: ["a/b", "c/d"] });
	});
});
