import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import packageMetadata from "../../../../package.json" with { type: "json" };
import { experimentalValidators, stableValidators } from "../../protocol-source/schema-validators.generated";
import { validators } from "../../protocol-source/validators.generated";
import {
	environmentAppHandlers,
	environmentInfoHandler,
	environmentStatusHandler,
	externalAgentConfigDetectHandler,
	externalAgentConfigImportHandler,
	externalAgentConfigImportReadHistoriesHandler,
	externalAgentConfigImportRecordHistoryHandler,
	getExternalAgentImportHistoryPath,
} from "../../suites/environment-app-handlers";

type SuccessResult = { ok: true; result: unknown };
type HandlerResponse = SuccessResult | { ok: false; errorKey: string };

// realpath: macOS resolves /var to /private/var, and the runtime reports the canonical path.
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gjc-environment-app-suite-")));
const workspace = path.join(root, "workspace");
const externalHome = path.join(root, "external-home");
const agentDir = path.join(root, "agent");
const previousCwd = process.cwd();
const previousHome = process.env.HOME;
const previousAgentDir = process.env.GJC_AGENT_DIR;

function resultOf(response: HandlerResponse): unknown {
	if (!response.ok) throw new Error(response.errorKey);
	return response.result;
}

beforeAll(() => {
	mkdirSync(workspace, { recursive: true });
	mkdirSync(externalHome, { recursive: true });
	process.env.HOME = externalHome;
	process.env.GJC_AGENT_DIR = agentDir;
	process.chdir(workspace);
	execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
	execFileSync("git", ["config", "user.email", "environment-suite@example.test"], { cwd: workspace });
	execFileSync("git", ["config", "user.name", "Environment Suite"], { cwd: workspace });
	writeFileSync(path.join(workspace, "tracked.txt"), "environment\n");
	execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
	execFileSync("git", ["commit", "-m", "environment fixture"], { cwd: workspace });
});

afterAll(() => {
	process.chdir(previousCwd);
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousAgentDir === undefined) delete process.env.GJC_AGENT_DIR;
	else process.env.GJC_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

test("environment/info reports real platform, version, workspace, and git facts", async () => {
	const params = { environmentId: "local" };
	expect(experimentalValidators.clientRequestParams["environment/info"]?.(params)).toBe(true);
	const response = await environmentInfoHandler(params);
	const info = resultOf(response) as Record<string, unknown>;
	expect(experimentalValidators.clientRequestResults["environment/info"]?.(info)).toBe(true);

	const platform = info.platform as Record<string, unknown>;
	const versions = info.versions as Record<string, unknown>;
	const workspaceInfo = info.workspace as Record<string, unknown>;
	const expectedBranch = execFileSync("git", ["branch", "--show-current"], {
		cwd: workspace,
		encoding: "utf8",
	}).trim();
	const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();

	expect(platform.os).toBe(process.platform);
	expect(platform.family).toBe(os.type());
	expect(versions.gjc).toBe(packageMetadata.version);
	expect(versions.node).toBe(process.versions.node);
	expect(info.cwd).toBe(pathToFileURL(workspace).href);
	expect(workspaceInfo.repoRoot).toBe(workspace);
	expect(workspaceInfo.branch).toBe(expectedBranch);
	expect(workspaceInfo.head).toBe(expectedHead);
});

test("environment/status reports a ready local environment with the same real workspace state", async () => {
	const params = { environmentId: "local" };
	expect(experimentalValidators.clientRequestParams["environment/status"]?.(params)).toBe(true);
	const response = await environmentStatusHandler(params);
	const status = resultOf(response) as Record<string, unknown>;
	expect(experimentalValidators.clientRequestResults["environment/status"]?.(status)).toBe(true);
	expect(status.status).toBe("ready");
	expect((status.git as Record<string, unknown>).repoRoot).toBe(workspace);
});

test("externalAgentConfig/detect reads a real Claude config under the selected home and reports absence", async () => {
	const configPath = path.join(externalHome, ".claude.json");
	writeFileSync(
		configPath,
		JSON.stringify({ mcpServers: { environmentEcho: { command: "echo", args: ["environment"] } } }),
	);
	const params = { includeHome: true, migrationSource: "claude-code" };
	expect(stableValidators.clientRequestParams["externalAgentConfig/detect"]?.(params)).toBe(true);
	const detected = resultOf(await externalAgentConfigDetectHandler(params)) as {
		items: Array<Record<string, unknown>>;
	};
	expect(stableValidators.clientRequestResults["externalAgentConfig/detect"]?.(detected)).toBe(true);
	expect(detected.items).toHaveLength(1);
	expect(detected.items[0]).toMatchObject({
		itemType: "MCP_SERVER_CONFIG",
		description: 'claude-code MCP server "environmentEcho"',
		cwd: null,
	});

	rmSync(configPath);
	const absent = resultOf(await externalAgentConfigDetectHandler(params)) as { items: unknown[] };
	expect(absent.items).toEqual([]);
});

test("externalAgentConfig/import writes the real MCP destination and records history on disk", async () => {
	const configPath = path.join(externalHome, ".claude.json");
	writeFileSync(
		configPath,
		JSON.stringify({ mcpServers: { environmentImport: { command: "echo", args: ["imported"] } } }),
	);
	const detected = resultOf(
		await externalAgentConfigDetectHandler({ includeHome: true, migrationSource: "claude-code" }),
	) as { items: Array<Record<string, unknown>> };
	const imported = await externalAgentConfigImportHandler({
		migrationItems: detected.items,
		migrationSource: "claude-code",
		providerId: "environment-suite",
	});
	const importResult = resultOf(imported) as { importId: string };
	expect(stableValidators.clientRequestResults["externalAgentConfig/import"]?.(importResult)).toBe(true);
	expect(JSON.parse(readFileSync(path.join(agentDir, "mcp.json"), "utf8")).mcpServers.environmentImport).toEqual({
		command: "echo",
		args: ["imported"],
		type: "stdio",
	});
	expect(readFileSync(getExternalAgentImportHistoryPath(), "utf8")).toContain(importResult.importId);

	const histories = resultOf(await externalAgentConfigImportReadHistoriesHandler({})) as {
		data: Array<Record<string, unknown>>;
		connectors: unknown[];
	};
	expect(stableValidators.clientRequestResults["externalAgentConfig/import/readHistories"]?.(histories)).toBe(true);
	expect(histories.connectors).toEqual([]);
	expect(histories.data.some(entry => entry.importId === importResult.importId)).toBe(true);

	const recorded = await externalAgentConfigImportRecordHistoryHandler({
		providerId: "manual-provider",
		itemTypeResults: [
			{
				itemType: "SKILLS",
				successes: [{ itemType: "SKILLS", cwd: null, source: "claude-code", target: "skills/demo" }],
				failures: [],
			},
		],
	});
	const recordedResult = resultOf(recorded) as { importId: string };
	expect(stableValidators.clientRequestResults["externalAgentConfig/import/recordHistory"]?.(recordedResult)).toBe(
		true,
	);
	const afterRecord = resultOf(await externalAgentConfigImportReadHistoriesHandler({})) as {
		data: Array<Record<string, unknown>>;
	};
	expect(afterRecord.data.some(entry => entry.importId === recordedResult.importId)).toBe(true);
});

test("environment-app handlers reject malformed pinned params and omit unbacked methods", async () => {
	expect(validators["environment/info"]?.({})).toBe(false);
	expect(await environmentInfoHandler({})).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(validators["environment/status"]?.({})).toBe(false);
	expect(await environmentStatusHandler({})).toEqual({ ok: false, errorKey: "invalidParams" });

	expect(validators["externalAgentConfig/detect"]?.({})).toBe(false);
	expect(await externalAgentConfigDetectHandler({})).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await externalAgentConfigDetectHandler({ includeHome: "yes" })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});

	expect(validators["externalAgentConfig/import"]?.({})).toBe(false);
	expect(await externalAgentConfigImportHandler({})).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await externalAgentConfigImportHandler({ migrationItems: "not-an-array" })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});

	// The pinned required-key list for readHistories is empty, so {} is a valid
	// request and must not be treated as malformed. A primitive remains invalid.
	expect(validators["externalAgentConfig/import/readHistories"]?.({})).toBe(true);
	expect((await externalAgentConfigImportReadHistoriesHandler({})).ok).toBe(true);
	expect(await externalAgentConfigImportReadHistoriesHandler("not-an-object")).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});

	expect(validators["externalAgentConfig/import/recordHistory"]?.({})).toBe(false);
	expect(await externalAgentConfigImportRecordHistoryHandler({})).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await externalAgentConfigImportRecordHistoryHandler({ providerId: "x", itemTypeResults: "bad" })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(Object.keys(environmentAppHandlers).sort()).toEqual([
		"environment/info",
		"environment/status",
		"externalAgentConfig/detect",
		"externalAgentConfig/import",
		"externalAgentConfig/import/readHistories",
		"externalAgentConfig/import/recordHistory",
	]);
	expect(environmentAppHandlers["environment/add"]).toBeUndefined();
	expect(environmentAppHandlers["app/list"]).toBeUndefined();
	expect(environmentAppHandlers["app/read"]).toBeUndefined();
	expect(environmentAppHandlers["app/installed"]).toBeUndefined();
});
