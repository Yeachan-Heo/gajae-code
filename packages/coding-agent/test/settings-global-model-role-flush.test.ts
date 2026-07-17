import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { YAML } from "bun";

describe("Settings global model role durability", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;
	let configPath: string;

	beforeEach(async () => {
		resetSettingsForTest();
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-settings-global-model-role-"));
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");
		configPath = path.join(agentDir, "config.yml");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("persists the canonical global selector without changing a runtime override", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.overrideModelRoles({ default: "profile/runtime:high" });

		// When
		await settings.setGlobalModelRoleAndFlush("default", "provider/selected:medium");

		// Then
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/selected:medium" },
		});
		expect(settings.getModelRole("default")).toBe("profile/runtime:high");
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/selected:medium" });
	});

	it("removes a restored default selector without changing other durable roles", async () => {
		// Given
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/selected:medium", planner: "planner/model:high" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		// When
		await settings.setGlobalModelRoleAndFlush("default", undefined);

		// Then
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { planner: "planner/model:high" },
		});
		expect(settings.getGlobal("modelRoles")).toEqual({ planner: "planner/model:high" });
	});

	it("rejects an older restore when direct model roles change during its durable flush", async () => {
		// Given: selection A starts durably committing B.
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/original:low", planner: "planner/original:medium" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const originalRename = fs.rename.bind(fs);
		const firstConfigRename = Promise.withResolvers<void>();
		const continueFirstConfigRename = Promise.withResolvers<void>();
		let configRename = 0;
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to !== configPath) {
				await originalRename(from, to);
				return;
			}
			configRename += 1;
			if (configRename === 1) {
				firstConfigRename.resolve();
				await continueFirstConfigRename.promise;
			}
			await originalRename(from, to);
		});

		const selection = settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		await firstConfigRename.promise;

		// When: direct writer C commits while B's durable flush remains pending.
		const newerRoles = {
			default: "provider/selection-c:medium",
			planner: "planner/original:medium",
			reviewer: "reviewer/newer:low",
		};
		settings.set("modelRoles", newerRoles);
		continueFirstConfigRename.resolve();
		const commit = await selection;
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);
		await settings.flush();

		// Then: A cannot replace C or discard C's unrelated role in memory or YAML.
		expect(restored).toBe(false);
		expect(settings.getGlobal("modelRoles")).toEqual(newerRoles);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ modelRoles: newerRoles });
	});

	it("does not restore across a clone's newer durable default", async () => {
		// Given
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/original:low", planner: "planner/original:medium" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		const clone = await settings.cloneForCwd(projectDir);

		// When
		await clone.setGlobalModelRoleAndFlush("default", "provider/selection-c:medium");
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then
		const newerRoles = { default: "provider/selection-c:medium", planner: "planner/original:medium" };
		expect(restored).toBe(false);
		expect(clone.getGlobal("modelRoles")).toEqual(newerRoles);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ modelRoles: newerRoles });
	});

	it("drops a stale pending default patch after a clone commits a newer default", async () => {
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setGlobalModelRole("default", "provider/pending-b:high");
		const clone = await settings.cloneForCwd(projectDir);

		await clone.setGlobalModelRoleAndFlush("default", "provider/selection-c:medium");
		await settings.flushOrThrow();

		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/selection-c:medium" });
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/selection-c:medium" },
		});
	});

	it("drops a pending default patch after an external durable write", async () => {
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setGlobalModelRole("default", "provider/pending-b:high");

		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/external-c:medium" } }));
		await settings.flushOrThrow();

		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/external-c:medium" });
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/external-c:medium" },
		});
	});

	it("restores the external default in memory when an unrelated save fails", async () => {
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setGlobalModelRole("default", "provider/pending-b:high");
		settings.set("theme.dark", "amber-claw");
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/external-c:medium" } }));
		const originalRename = fs.rename.bind(fs);
		const write = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to === configPath) throw new Error("injected unrelated save failure");
			await originalRename(from, to);
		});

		await settings.flush();

		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/external-c:medium" });
		expect(settings.get("theme.dark")).toBe("amber-claw");
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/external-c:medium" },
		});

		write.mockRestore();
		settings.setGlobalModelRole("default", "provider/next-d:high");
		await settings.flushOrThrow();
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/next-d:high" },
			theme: { dark: "amber-claw" },
		});
	});

	it("keeps an external default after a local unrelated write", async () => {
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setGlobalModelRole("default", "provider/pending-b:high");
		const clone = await settings.cloneForCwd(projectDir);

		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/external-c:medium" } }));
		clone.setGlobalModelRole("planner", "planner/local:high");
		await clone.flushOrThrow();
		await settings.flushOrThrow();

		const expected = { default: "provider/external-c:medium", planner: "planner/local:high" };
		expect(settings.getGlobal("modelRoles")).toEqual(expected);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ modelRoles: expected });
	});

	it("restores an earlier token after a clone's newer durable write fails", async () => {
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const clone = await settings.cloneForCwd(projectDir);
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		const originalRename = fs.rename.bind(fs);
		let rejectConfigRename = true;
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to === configPath && rejectConfigRename) {
				rejectConfigRename = false;
				throw new Error("clone durable write failed");
			}
			await originalRename(from, to);
		});

		await expect(clone.setGlobalModelRoleAndFlush("default", "provider/selection-c:medium")).rejects.toThrow(
			"clone durable write failed",
		);
		expect(await settings.restoreGlobalDefaultModelRoleIfCurrent(commit)).toBe(true);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/original:low" },
		});
	});

	it("applies mixed root and role patches in generation order", async () => {
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setGlobalModelRole("default", "provider/role-old:low");
		settings.set("modelRoles", {
			default: "provider/root-middle:medium",
			planner: "planner/newer:high",
		});
		settings.setGlobalModelRole("default", "provider/role-new:high");

		await settings.flushOrThrow();

		const expected = { default: "provider/role-new:high", planner: "planner/newer:high" };
		expect(settings.getGlobal("modelRoles")).toEqual(expected);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ modelRoles: expected });
	});

	it("detects same-value default ABA committed by a clone", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		const clone = await settings.cloneForCwd(projectDir);

		// When
		await clone.setGlobalModelRoleAndFlush("default", "provider/original:low");
		await clone.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then
		expect(restored).toBe(false);
		expect(clone.getGlobal("modelRoles")).toEqual({ default: "provider/selection-b:high" });
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/selection-b:high" },
		});
	});

	it("detects an external same-value default ABA", async () => {
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");

		await Bun.sleep(1);
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/selection-b:high" } }));

		expect(await settings.restoreGlobalDefaultModelRoleIfCurrent(commit)).toBe(false);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/selection-b:high" },
		});
	});

	it("does not launder an external ABA through a local unrelated write", async () => {
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		const clone = await settings.cloneForCwd(projectDir);

		await Bun.sleep(1);
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/selection-b:high" } }));
		clone.setGlobalModelRole("planner", "planner/local:medium");
		await clone.flushOrThrow();

		expect(await settings.restoreGlobalDefaultModelRoleIfCurrent(commit)).toBe(false);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/selection-b:high", planner: "planner/local:medium" },
		});
	});

	it("restores only default while preserving a clone's unrelated durable role", async () => {
		// Given
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/original:low", planner: "planner/original:medium" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		const clone = await settings.cloneForCwd(projectDir);

		// When
		clone.setGlobalModelRole("planner", "planner/newer:medium");
		await clone.flush();
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then
		const restoredRoles = { default: "provider/original:low", planner: "planner/newer:medium" };
		expect(restored).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual(restoredRoles);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ modelRoles: restoredRoles });
	});

	it("captures the durable predecessor committed by a clone", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const clone = await settings.cloneForCwd(projectDir);
		await clone.setGlobalModelRoleAndFlush("default", "provider/durable-predecessor:medium");

		// When
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then
		expect(commit).toEqual({
			previousDefault: "provider/durable-predecessor:medium",
			previousModelRolesExisted: true,
			committedDefault: "provider/selection-b:high",
			committedConfigVersion: expect.any(String),
			defaultRevision: expect.any(Number),
		});
		expect(restored).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/durable-predecessor:medium" });
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/durable-predecessor:medium" },
		});
	});

	it("restores an absent original default without changing unrelated durable roles", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { planner: "planner/original:medium" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");
		expect(commit).toEqual({
			previousDefault: undefined,
			previousModelRolesExisted: true,
			committedDefault: "provider/selection-b:high",
			committedConfigVersion: expect.any(String),
			defaultRevision: expect.any(Number),
		});

		// When
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then
		expect(restored).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({ planner: "planner/original:medium" });
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { planner: "planner/original:medium" },
		});
	});

	it("restores the committed default after a planner-only helper update", async () => {
		// Given: selection A durably commits B while planner retains an independent role.
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/original:low", planner: "planner/original:medium" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");

		// When: an unrelated helper update writes planner before B must be rolled back.
		settings.setModelRole("planner", "planner/newer:medium");
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then: recovery owns A while preserving planner Q in memory and YAML.
		expect(restored).toBe(true);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "provider/original:low",
			planner: "planner/newer:medium",
		});
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/original:low", planner: "planner/newer:medium" },
		});
	});

	it("treats helper writes and same-value ABA as newer default revisions", async () => {
		// Given
		await Bun.write(
			configPath,
			YAML.stringify({ modelRoles: { default: "provider/original:low", planner: "planner/original:medium" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const commit = await settings.setGlobalModelRoleAndFlush("default", "provider/selection-b:high");

		// When: helper mutations return the default to B after an A/B ABA sequence.
		settings.setGlobalModelRole("planner", "planner/newer:medium");
		settings.setGlobalModelRole("default", "provider/original:low");
		settings.setGlobalModelRole("default", "provider/selection-b:high");
		await settings.flush();
		const restored = await settings.restoreGlobalDefaultModelRoleIfCurrent(commit);

		// Then: matching the prior value is insufficient ownership to restore it.
		expect(restored).toBe(false);
		expect(settings.getGlobal("modelRoles")).toEqual({
			default: "provider/selection-b:high",
			planner: "planner/newer:medium",
		});
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/selection-b:high", planner: "planner/newer:medium" },
		});
	});

	it("rolls back a rejected selector so an unrelated later save cannot retry it", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const originalRename = fs.rename.bind(fs);
		let rejectConfigRename = true;
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to === configPath && rejectConfigRename) {
				rejectConfigRename = false;
				throw new Error("injected config write failure");
			}
			await originalRename(from, to);
		});

		// When
		const rejected = settings.setGlobalModelRoleAndFlush("default", "provider/rejected:high");

		// Then
		await expect(rejected).rejects.toThrow("injected config write failure");
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/original:low" });
		expect(settings.getModelRole("default")).toBe("provider/original:low");
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/original:low" },
		});

		settings.set("theme.dark", "amber-claw");
		await settings.flush();
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/original:low" },
			theme: { dark: "amber-claw" },
		});
	});

	it("preserves a newer selector when an older queued selector is rejected", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const originalRename = fs.rename.bind(fs);
		const predecessorRename = Promise.withResolvers<void>();
		let waitedForPredecessor = false;
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to !== configPath) {
				await originalRename(from, to);
				return;
			}
			if (!waitedForPredecessor) {
				waitedForPredecessor = true;
				await predecessorRename.promise;
			}
			const candidate = YAML.parse(await fs.readFile(from, "utf8")) as { modelRoles?: { default?: string } };
			if (candidate.modelRoles?.default === "provider/rejected:high") {
				throw new Error("injected older selector failure");
			}
			await originalRename(from, to);
		});

		settings.set("theme.dark", "predecessor-claw");
		const predecessor = settings.flush();
		const older = settings.setGlobalModelRoleAndFlush("default", "provider/rejected:high");
		const newer = settings.setGlobalModelRoleAndFlush("default", "provider/newer:medium");

		// When
		predecessorRename.resolve();

		// Then
		await predecessor;
		await expect(older).rejects.toThrow("injected older selector failure");
		await newer;
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/newer:medium" });
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/newer:medium" },
			theme: { dark: "predecessor-claw" },
		});
	});

	it("rolls both overlapping rejected selectors back before an unrelated save", async () => {
		// Given
		await Bun.write(configPath, YAML.stringify({ modelRoles: { default: "provider/original:low" } }));
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.overrideModelRoles({ planner: "profile/planner:high" });
		const originalRename = fs.rename.bind(fs);
		const predecessorRename = Promise.withResolvers<void>();
		let waitedForPredecessor = false;
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to !== configPath) {
				await originalRename(from, to);
				return;
			}
			if (!waitedForPredecessor) {
				waitedForPredecessor = true;
				await predecessorRename.promise;
			}
			const candidate = YAML.parse(await fs.readFile(from, "utf8")) as { modelRoles?: { default?: string } };
			if (candidate.modelRoles?.default === "provider/older-rejected:high") {
				throw new Error("injected selector failure 2");
			}
			if (candidate.modelRoles?.default === "provider/newer-rejected:medium") {
				throw new Error("injected selector failure 3");
			}
			await originalRename(from, to);
		});

		settings.set("theme.dark", "predecessor-claw");
		const predecessor = settings.flush();
		const older = settings.setGlobalModelRoleAndFlush("default", "provider/older-rejected:high");
		const newer = settings.setGlobalModelRoleAndFlush("default", "provider/newer-rejected:medium");
		const selections = Promise.allSettled([older, newer]);

		// When
		predecessorRename.resolve();

		// Then
		await predecessor;
		expect((await selections).map(result => result.status)).toEqual(["rejected", "rejected"]);
		settings.set("theme.dark", "red-claw");
		await settings.flush();
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			modelRoles: { default: "provider/original:low" },
			theme: { dark: "red-claw" },
		});
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "provider/original:low" });
		expect(settings.get("modelRoles")).toEqual({
			default: "provider/original:low",
			planner: "profile/planner:high",
		});
	});

	it("does not re-dirty a patch after an earlier duplicate save has persisted it", async () => {
		// Given: two queued saves that snapshot the same patch before the first write settles.
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const originalRename = fs.rename.bind(fs);
		const firstRename = Promise.withResolvers<void>();
		let configRename = 0;
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to !== configPath) {
				await originalRename(from, to);
				return;
			}
			configRename += 1;
			if (configRename === 1) await firstRename.promise;
			if (configRename === 2) throw new Error("injected duplicate save failure");
			await originalRename(from, to);
		});

		settings.set("theme.dark", "red-claw");
		const first = settings.flush();
		const duplicate = settings.flush();

		// When: the first snapshot persists, then the obsolete duplicate snapshot fails.
		firstRename.resolve();
		await first;
		await duplicate;
		await Bun.write(configPath, YAML.stringify({}));
		settings.set("theme.light", "blue-crab");
		await settings.flush();

		// Then: a later unrelated save cannot replay the stale, already-persisted patch.
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ theme: { light: "blue-crab" } });
	});
});
