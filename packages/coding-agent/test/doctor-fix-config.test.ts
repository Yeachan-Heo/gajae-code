import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NativeExactFileIdentity } from "@gajae-code/natives";
import { YAML } from "bun";
import { applyDoctorConfigRepair } from "../src/cli/doctor/config-repairs";
import { configTargetId, mcpTargetId, resolveDoctorRoot } from "../src/cli/doctor/ids";
import type { DoctorCheck } from "../src/cli/doctor/types";

const fixtureRoots: string[] = [];
afterEach(async () => {
	await Promise.all(fixtureRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(raw: string, name = "config.yml") {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "doctor-")));
	fixtureRoots.push(root);
	const filePath = path.join(root, name);
	await Bun.write(filePath, raw);
	await fs.chmod(filePath, 0o600);
	const stat = await fs.lstat(filePath, { bigint: true });
	const parent = await fs.lstat(root, { bigint: true });
	const identity: NativeExactFileIdentity = {
		dev: stat.dev,
		ino: stat.ino,
		nlink: stat.nlink,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		parentDev: parent.dev,
		parentIno: parent.ino,
		sha256: crypto.createHash("sha256").update(raw).digest("hex"),
	};
	return { root, filePath, identity };
}
function request(filePath: string, root: string, raw: string, identity: NativeExactFileIdentity) {
	const rootId = resolveDoctorRoot("config-project", root).rootId;
	const targetId = nameIsJson(filePath)
		? mcpTargetId(rootId, "project", "org.example", "autoload")
		: configTargetId(rootId, "project", "skills.enabled");
	return {
		filePath,
		rootPath: root,
		scope: "project" as const,
		targetId,
		repairId: nameIsJson(filePath) ? "mcp.set-startup-policy" : "config.set-validated",
		runId: crypto.randomUUID(),
		mode: "fix" as const,
		authorization: ["config-change"],
		journalRoot: root,
		expected: { raw, identity },
		collectAfterChecks: async () => {
			const text = await fs.readFile(filePath, "utf8");
			const parsed = nameIsJson(filePath) ? JSON.parse(text) : YAML.parse(text);
			const value = nameIsJson(filePath)
				? (parsed.mcpServers?.["org.example"]?.autoload ?? parsed.mcpServers?.["org.example"]?.enabled)
				: parsed.skills?.enabled;
			return [
				{
					id: "target-check",
					targetId,
					execution: "completed",
					health: "ok",
					evidenceLevel: "observed",
					dependsOn: [],
					evidence: { enabled: value, autoload: value },
					remediationIds: [],
				} satisfies DoctorCheck,
			];
		},
	};
}

function nameIsJson(filePath: string): boolean {
	return filePath.endsWith(".json");
}

describe("doctor config repairs", () => {
	test("repairs invalid scalar while preserving siblings", async () => {
		const raw = "skills:\n  enabled: secret-sentinel\n  enableSkillCommands: true\nother: keep\n";
		const f = await fixture(raw);
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "skill",
			schemaKey: "skills.enabled",
			value: true,
		});
		expect(result.repair.outcome?.mutationVerified).toBe(true);
		expect(await fs.readFile(f.filePath, "utf8")).toContain("enableSkillCommands: true");
	});

	test("authorization and no-op perform no writes", async () => {
		const raw = "skills:\n  enabled: true\n";
		const f = await fixture(raw);
		const denied = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			authorization: [],
			kind: "skill",
			schemaKey: "skills.enabled",
			value: false,
		});
		expect(denied.repair.state).toBe("blocked");
		const noop = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "skill",
			schemaKey: "skills.enabled",
			value: true,
		});
		expect(noop.repair.state).toBe("not_needed");
	});

	test("rejects changed target contents", async () => {
		const raw = "skills:\n  enabled: false\n";
		const f = await fixture(raw);
		await fs.writeFile(f.filePath, "skills:\n  enabled: nope\n");
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "skill",
			schemaKey: "skills.enabled",
			value: true,
		});
		expect(result.repair.state).toBe("blocked");
	});

	test("repairs dotted MCP key and treats false policy as success", async () => {
		const raw = `${JSON.stringify({ disabledServers: ["other"], mcpServers: { "org.example": { autoload: true, secret: "raw" } } }, null, 2)}\n`;
		const f = await fixture(raw, "mcp.json");
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "mcp",
			serverName: "org.example",
			field: "autoload",
			value: false,
		});
		expect(result.repair.outcome?.desiredStartupStateAchieved).toBe(true);
	});

	test("refuses a replacement inode even when its contents are identical", async () => {
		const raw = "skills:\n  enabled: false\n";
		const f = await fixture(raw);
		const replacement = path.join(f.root, "replacement.yml");
		await Bun.write(replacement, raw);
		await fs.chmod(replacement, 0o600);
		const replacementIdentity = await fs.lstat(replacement, { bigint: true });
		await fs.rename(replacement, f.filePath);
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "skill",
			schemaKey: "skills.enabled",
			value: true,
		});
		expect(result.repair).toMatchObject({
			state: "blocked",
			reasonCode: "identity_recheck_required",
			sideEffectStarted: false,
		});
		expect((await fs.lstat(f.filePath, { bigint: true })).ino).toBe(replacementIdentity.ino);
		expect(await fs.readdir(f.root)).toEqual(["config.yml"]);
	});

	test("does not verify a no-op without a selected completed after-check", async () => {
		const raw = "skills:\n  enabled: true\n";
		const f = await fixture(raw);
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "skill",
			schemaKey: "skills.enabled",
			value: true,
			collectAfterChecks: async () => [],
		});
		expect(result.repair).toMatchObject({
			state: "blocked",
			reasonCode: "target_after_check_missing",
			sideEffectStarted: false,
		});
		expect(await fs.readdir(f.root)).toEqual(["config.yml"]);
	});

	test("keeps the verified selected mutation when an unrelated check fails", async () => {
		const raw = "skills:\n  enabled: false\n";
		const f = await fixture(raw);
		const input = request(f.filePath, f.root, raw, f.identity);
		const result = await applyDoctorConfigRepair({
			...input,
			kind: "skill",
			schemaKey: "skills.enabled",
			value: true,
			collectAfterChecks: async () => [
				...(await input.collectAfterChecks()),
				{
					id: "unrelated-check",
					targetId: "unrelated-target",
					execution: "completed",
					health: "error",
					evidenceLevel: "observed",
					evidence: {},
					dependsOn: [],
					remediationIds: [],
				},
			],
		});
		expect(result.repair).toMatchObject({ state: "verified", outcome: { mutationVerified: true } });
		expect((YAML.parse(await Bun.file(f.filePath).text()) as { skills: { enabled: boolean } }).skills.enabled).toBe(
			true,
		);
		expect(result.afterChecks?.some(check => check.id === "unrelated-check" && check.health === "error")).toBe(true);
	});

	test("rolls back only the MCP field while retaining an in-place sibling edit", async () => {
		const raw = JSON.stringify({ mcpServers: { "org.example": { autoload: false, command: "original" } } });
		const f = await fixture(raw, "mcp.json");
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "mcp",
			serverName: "org.example",
			field: "autoload",
			value: true,
			collectAfterChecks: async () => {
				const current = await Bun.file(f.filePath).json();
				current.mcpServers["org.example"].command = "concurrent-sibling";
				await Bun.write(f.filePath, JSON.stringify(current));
				return [];
			},
		});
		expect(result.repair.state).toBe("rolled_back");
		expect(result.repair.sideEffectStarted).toBe(true);
		expect(await Bun.file(f.filePath).json()).toEqual({
			mcpServers: { "org.example": { autoload: false, command: "concurrent-sibling" } },
		});
	});

	test("restores invalid numeric and object tokens without numeric normalization", async () => {
		for (const literal of ["9007199254740993", "-0", '{"nested":9007199254740993}']) {
			const raw = `{"mcpServers":{"org.example":{"autoload":${literal},"command":"original"}}}`;
			const f = await fixture(raw, "mcp.json");
			const result = await applyDoctorConfigRepair({
				...request(f.filePath, f.root, raw, f.identity),
				kind: "mcp",
				serverName: "org.example",
				field: "autoload",
				value: true,
				collectAfterChecks: async () => [],
			});
			expect(result.repair.state).toBe("rolled_back");
			expect(await Bun.file(f.filePath).text()).toBe(raw);
		}
	});

	test("runs core after-check collector only after mutation", async () => {
		const raw = "skills:\n  enabled: false\n";
		const f = await fixture(raw);
		let observed = false;
		const input = request(f.filePath, f.root, raw, f.identity);
		const result = await applyDoctorConfigRepair({
			...input,
			kind: "skill",
			schemaKey: "skills.enabled",
			value: true,
			collectAfterChecks: async () => {
				observed = (await fs.readFile(f.filePath, "utf8")).includes("enabled: true");
				return [
					{
						id: "config.project.skills.enabled",
						targetId: input.targetId,
						execution: "completed",
						health: "ok",
						evidenceLevel: "observed",
						dependsOn: [],
						evidence: { enabled: observed },
						remediationIds: [],
					} satisfies DoctorCheck,
				];
			},
		});
		expect(observed).toBe(true);
		expect(result.afterChecks?.[0]?.targetId).toBe(input.targetId);
	});

	test("preserves an unrelated large-integer literal and negative zero across a lossless MCP edit", async () => {
		const raw =
			'{\n  "mcpServers": {\n    "org.example": {\n      "autoload": false,\n      "timeout": 9007199254740993,\n      "weight": -0\n    }\n  }\n}';
		const f = await fixture(raw, "mcp.json");
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "mcp",
			serverName: "org.example",
			field: "autoload",
			value: true,
		});
		expect(result.repair.outcome?.mutationVerified).toBe(true);
		const text = await fs.readFile(f.filePath, "utf8");
		expect(text).toContain("9007199254740993");
		expect(text).toContain("-0");
		expect(text).toContain('"autoload": true');
	});

	test("rolling back an originally-absent field removes the key and restores the byte-identical document", async () => {
		const raw = JSON.stringify({ mcpServers: { "org.example": { command: "original" } } });
		const f = await fixture(raw, "mcp.json");
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "mcp",
			serverName: "org.example",
			field: "autoload",
			value: true,
			collectAfterChecks: async () => {
				throw new Error("force rollback after mutation");
			},
		});
		expect(result.repair.state).toBe("rolled_back");
		expect(result.repair.sideEffectStarted).toBe(true);
		const restoredText = await fs.readFile(f.filePath, "utf8");
		expect(restoredText).toBe(raw);
		expect(JSON.parse(restoredText).mcpServers["org.example"]).not.toHaveProperty("autoload");
	});

	test("rolling back an originally-invalid scalar restores the byte-identical document", async () => {
		const raw =
			'{\n  "mcpServers": {\n    "org.example": {\n      "autoload": "yes",\n      "timeout": 9007199254740993\n    }\n  }\n}';
		const f = await fixture(raw, "mcp.json");
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "mcp",
			serverName: "org.example",
			field: "autoload",
			value: true,
			collectAfterChecks: async () => {
				throw new Error("force rollback after mutation");
			},
		});
		expect(result.repair.state).toBe("rolled_back");
		expect(result.repair.sideEffectStarted).toBe(true);
		const restoredText = await fs.readFile(f.filePath, "utf8");
		expect(restoredText).toBe(raw);
	});

	test("rejects a duplicate key along the selected server/field path before any journal or write", async () => {
		const raw =
			'{\n  "mcpServers": {\n    "org.example": {\n      "autoload": false,\n      "autoload": true\n    }\n  }\n}';
		const f = await fixture(raw, "mcp.json");
		const result = await applyDoctorConfigRepair({
			...request(f.filePath, f.root, raw, f.identity),
			kind: "mcp",
			serverName: "org.example",
			field: "autoload",
			value: true,
		});
		expect(result.repair.state).toBe("blocked");
		expect(result.repair.reasonCode).toMatch(/^duplicate_key_/);
		expect(result.repair.sideEffectStarted).toBe(false);
		expect(await fs.readFile(f.filePath, "utf8")).toBe(raw);
		expect(await fs.readdir(f.root)).toEqual(["mcp.json"]);
	});
});
