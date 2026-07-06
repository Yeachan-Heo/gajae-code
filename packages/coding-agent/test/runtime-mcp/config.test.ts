import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadAllMCPConfigs } from "../../src/runtime-mcp/config";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-config-defaults-"));
	await Bun.write(
		path.join(tmpDir, ".mcp.json"),
		`${JSON.stringify(
			{
				mcpServers: {
					project_auto: { command: "project-auto" },
					project_manual: { command: "project-manual", autoload: false },
				},
			},
			null,
			2,
		)}\n`,
	);
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadAllMCPConfigs security defaults", () => {
	test("excludes project configs and non-autoload servers unless explicitly enabled", async () => {
		const safeDefault = await loadAllMCPConfigs(tmpDir);
		expect(safeDefault.configs.project_auto).toBeUndefined();
		expect(safeDefault.configs.project_manual).toBeUndefined();

		const projectEnabled = await loadAllMCPConfigs(tmpDir, { enableProjectConfig: true });
		expect(projectEnabled.configs.project_auto).toHaveProperty("command", "project-auto");
		expect(projectEnabled.configs.project_manual).toBeUndefined();

		const projectAll = await loadAllMCPConfigs(tmpDir, { enableProjectConfig: true, autoloadOnly: false });
		expect(projectAll.configs.project_auto).toHaveProperty("command", "project-auto");
		expect(projectAll.configs.project_manual).toHaveProperty("command", "project-manual");
	});
});
