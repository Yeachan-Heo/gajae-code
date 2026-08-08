import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../config/settings";
import { buildVolatileProjectContext } from "../system-prompt";
import { buildWorkspaceTree } from "../workspace-tree";
import { createWorkspaceTreeService } from "./workspace-tree-service";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "gjc-workspace-tree-service-"));
	tempDirs.push(cwd);
	await mkdir(path.join(cwd, "src"));
	await Bun.write(path.join(cwd, "README.md"), "workspace");
	await Bun.write(path.join(cwd, "src", "main.ts"), "export {};");
	return cwd;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("workspace-tree runtime service", () => {
	test("default eager mode retains the legacy startup trigger and snapshot", async () => {
		const cwd = await makeWorkspace();
		const service = createWorkspaceTreeService(Settings.isolated(), cwd);

		expect(service.status().state).toBe("idle");
		const runtime = await service.get("legacy-startup");
		const expected = await buildWorkspaceTree(cwd);

		expect(service.status()).toMatchObject({ id: "workspaceTree", state: "ready", trigger: "legacy-startup" });
		expect(runtime.snapshot).toEqual(expected);
		await service.dispose();
	});

	test("lazy mode stays idle until the first-turn barrier and renders the resolved snapshot", async () => {
		const cwd = await makeWorkspace();
		const eagerService = createWorkspaceTreeService(Settings.isolated(), cwd);
		const eagerRuntime = await eagerService.get("legacy-startup");
		const settings = Settings.isolated({ "workspaceTree.mode": "lazy" });
		const service = createWorkspaceTreeService(settings, cwd);

		expect(service.status().state).toBe("idle");
		const runtime = await service.get("first-turn-barrier");
		const volatile = buildVolatileProjectContext({
			cwd,
			date: "2026-08-03",
			workspaceTree: runtime.snapshot,
		});

		expect(service.status()).toMatchObject({ id: "workspaceTree", state: "ready", trigger: "first-turn-barrier" });
		expect(runtime.snapshot).toEqual(eagerRuntime.snapshot);
		expect(volatile).toContain(eagerRuntime.snapshot.rendered);
		expect(volatile).toContain("<workspace-tree>");
		await service.dispose();
		await eagerService.dispose();
	});
});
