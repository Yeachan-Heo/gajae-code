import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath } from "@gajae-code/utils";
import { selectorHead } from "../../../config/model-selector-value";
import { Settings } from "../../../config/settings";
import { getMemoryRoot } from "../../../memories";
import { openMemoryDb, upsertThreads } from "../../../memories/storage";
import { experimentalValidators, stableValidators } from "../../protocol-source/schema-validators.generated";
import {
	collaborationModeListHandler,
	experimentalFeatureEnablementSetHandler,
	memoryResetHandler,
	policyConfigHandlers,
} from "../../suites/policy-config-handlers";

const root = mkdtempSync(path.join(os.tmpdir(), "gjc-policy-config-suite-"));
const agentDir = path.join(root, "agent");
const workspace = path.join(root, "workspace");
const previousAgentDir = process.env.GJC_AGENT_DIR;
const previousCwd = process.cwd();

function resultOf(value: { ok: true; result: unknown } | { ok: false; errorKey: string }): unknown {
	if (!value.ok) throw new Error(`handler failed: ${value.errorKey}`);
	return value.result;
}

beforeAll(() => {
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	writeFileSync(
		path.join(agentDir, "config.yml"),
		[
			"plan:",
			"  enabled: true",
			"memory:",
			"  backend: local",
			"modelRoles:",
			"  default: fixture/default-model:low",
			"  planner: fixture/planner-model:high",
			"tools:",
			"  preAdmissionArtifactSpill: false",
			"contextPromotion:",
			"  enabled: false",
			"",
		].join("\n"),
	);
	process.env.GJC_AGENT_DIR = agentDir;
	process.chdir(workspace);
});

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.GJC_AGENT_DIR;
	else process.env.GJC_AGENT_DIR = previousAgentDir;
	process.chdir(previousCwd);
	rmSync(root, { recursive: true, force: true });
});

test("collaborationMode/list projects the real default and enabled plan modes", async () => {
	const params = {};
	expect(experimentalValidators.clientRequestParams["collaborationMode/list"]?.(params)).toBe(true);

	const settings = await Settings.loadForScope({ cwd: workspace, agentDir });
	const roles = settings.get("modelRoles");
	const result = await collaborationModeListHandler(params);
	const payload = resultOf(result) as {
		data: Array<{ name: string; mode: string; model: string | null; reasoning_effort: string | null }>;
	};

	expect(experimentalValidators.clientRequestResults["collaborationMode/list"]?.(payload)).toBe(true);
	expect(settings.get("plan.enabled")).toBe(true);
	expect(payload.data.map(mode => mode.name)).toEqual(["default", "plan"]);
	expect(payload.data).toEqual([
		{
			name: "default",
			mode: "default",
			model: selectorHead(roles.default) ?? null,
			reasoning_effort: "low",
		},
		{
			name: "plan",
			mode: "plan",
			model: selectorHead(roles.planner) ?? null,
			reasoning_effort: "high",
		},
	]);
});

test("collaborationMode/list rejects payload fields and malformed params", async () => {
	expect(await collaborationModeListHandler({ cwd: workspace })).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await collaborationModeListHandler([])).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await collaborationModeListHandler("plan")).toEqual({ ok: false, errorKey: "invalidParams" });
});

test("experimentalFeature/enablement/set atomically persists a real GJC flag and rejects unknown flags", async () => {
	const params = { enablement: { "tools.preAdmissionArtifactSpill": true } };
	expect(stableValidators.clientRequestParams["experimentalFeature/enablement/set"]?.(params)).toBe(true);

	const result = await experimentalFeatureEnablementSetHandler(params);
	const payload = resultOf(result) as { enablement: Record<string, boolean> };
	expect(stableValidators.clientRequestResults["experimentalFeature/enablement/set"]?.(payload)).toBe(true);
	expect(payload).toEqual({ enablement: { "tools.preAdmissionArtifactSpill": true } });

	const reread = await Settings.loadForScope({ cwd: workspace, agentDir });
	expect(reread.get("tools.preAdmissionArtifactSpill")).toBe(true);
	expect(readFileSync(path.join(agentDir, "config.yml"), "utf8")).toContain("preAdmissionArtifactSpill: true");

	expect(await experimentalFeatureEnablementSetHandler({ enablement: { "unknown.flag": true } })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(
		await experimentalFeatureEnablementSetHandler({ enablement: { "tools.preAdmissionArtifactSpill": "yes" } }),
	).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});
	expect(await experimentalFeatureEnablementSetHandler({ enablement: true })).toEqual({
		ok: false,
		errorKey: "invalidParams",
	});

	const restored = await experimentalFeatureEnablementSetHandler({
		enablement: { "tools.preAdmissionArtifactSpill": false },
	});
	expect(restored.ok).toBe(true);
});

test("memory/reset clears the real local SQLite memory store and project artifacts", async () => {
	const memoryRoot = getMemoryRoot(agentDir, workspace);
	mkdirSync(memoryRoot, { recursive: true });
	writeFileSync(path.join(memoryRoot, "MEMORY.md"), "durable memory");
	writeFileSync(path.join(memoryRoot, "memory_summary.md"), "summary");

	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		upsertThreads(db, [
			{
				id: "memory-thread",
				updatedAt: Date.now(),
				rolloutPath: path.join(workspace, "rollout.jsonl"),
				cwd: workspace,
				sourceKind: "app",
			},
		]);
		expect((db.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count).toBe(1);
	} finally {
		db.close();
	}

	const result = await memoryResetHandler({});
	expect(result).toEqual({ ok: true, result: {} });
	if (result.ok) expect(experimentalValidators.clientRequestResults["memory/reset"]?.(result.result)).toBe(true);

	const after = openMemoryDb(getAgentDbPath(agentDir));
	try {
		expect((after.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count).toBe(0);
		expect((after.prepare("SELECT COUNT(*) AS count FROM stage1_outputs").get() as { count: number }).count).toBe(0);
		expect(
			(
				after
					.prepare(
						"SELECT COUNT(*) AS count FROM jobs WHERE kind IN ('memory_stage1', 'memory_consolidate_global')",
					)
					.get() as {
					count: number;
				}
			).count,
		).toBe(0);
	} finally {
		after.close();
	}
	expect(Bun.file(memoryRoot).exists()).resolves.toBe(false);
});

test("memory/reset rejects malformed params and refuses an inactive no-op backend", async () => {
	expect(await memoryResetHandler({ scope: workspace })).toEqual({ ok: false, errorKey: "invalidParams" });
	expect(await memoryResetHandler([])).toEqual({ ok: false, errorKey: "invalidParams" });

	const settings = await Settings.loadForScope({ cwd: workspace, agentDir });
	await settings.commitAtomicBatch([{ path: "memory.backend", op: "set", value: "off" }]);
	try {
		expect(await memoryResetHandler({})).toEqual({ ok: false, errorKey: "notSupported" });
	} finally {
		await settings.commitAtomicBatch([{ path: "memory.backend", op: "set", value: "local" }]);
	}
});

test("policyConfigHandlers registers only methods with genuine GJC backing", () => {
	expect(Object.keys(policyConfigHandlers).sort()).toEqual([
		"collaborationMode/list",
		"experimentalFeature/enablement/set",
		"memory/reset",
	]);
	// Omitted intentionally: GJC has no permission-profile policy registry and no
	// managed requirements.toml/MDM seam from which permissionProfile/list or
	// configRequirements/read could be translated without fabricating values.
});
