/**
 * Acceptance tests for `gjc customize doctor` (#4288).
 *
 * Covers the issue's acceptance criteria:
 *  1. deterministic fixture provenance/precedence across native `.gjc`,
 *     Claude, and Codex customizations;
 *  2. secret redaction in both text and JSON output;
 *  3. distinct reason codes for malformed/disabled/shadowed/quarantined/
 *     policy-blocked items;
 *  4. agreement with the actual session-startup consumers (`loadSkills`,
 *     `loadAllMCPConfigs`) — the doctor never claims a surface is active when
 *     startup ignores it (including the #4349 invariant that bundled workflow
 *     skills always win over same-name filesystem copies).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CustomizeDoctorReport,
	type CustomizeDoctorSurface,
	renderCustomizeDoctorJson,
	renderCustomizeDoctorText,
	runCustomizeDoctor,
} from "../src/cli/customize-doctor";
import { Settings } from "../src/config/settings";
import { functionHookGrantHash, normalizeFunctionHookGrant } from "../src/extensibility/extensions/function-hooks";
import { loadSkills } from "../src/extensibility/skills";
import { loadAllMCPConfigs } from "../src/runtime-mcp/config";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTempProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-customize-doctor-"));
	tempDirs.push(dir);
	return dir;
}

async function makeSkill(skillsRoot: string, name: string, description: string): Promise<string> {
	const filePath = path.join(skillsRoot, name, "SKILL.md");
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(
		filePath,
		["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`].join("\n"),
	);
	return filePath;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function surface(report: CustomizeDoctorReport, kind: CustomizeDoctorSurface["kind"]): CustomizeDoctorSurface {
	const found = report.surfaces.find(s => s.kind === kind);
	if (!found) throw new Error(`surface ${kind} missing from report`);
	return found;
}

function itemsByName(report: CustomizeDoctorReport, kind: CustomizeDoctorSurface["kind"]) {
	return new Map(surface(report, kind).items.map(item => [item.name, item]));
}

function withoutTimestamp(report: CustomizeDoctorReport): Omit<CustomizeDoctorReport, "generatedAt"> {
	const { generatedAt: _generatedAt, ...rest } = report;
	return rest;
}

describe("customize doctor (#4288)", () => {
	it("reports deterministic provenance and precedence across native, Claude, and Codex fixtures", async () => {
		const cwd = await makeTempProject();
		await makeSkill(path.join(cwd, ".gjc", "skills"), "fixture-native", "Native project skill");
		await makeSkill(path.join(cwd, ".claude", "skills"), "fixture-claude", "Claude convention skill");
		await makeSkill(path.join(cwd, ".codex", "skills"), "fixture-codex", "Codex convention skill");
		await writeJson(path.join(cwd, ".gjc", "mcp.json"), {
			mcpServers: { "fixture-native-mcp": { command: "true" } },
		});
		await writeJson(path.join(cwd, ".claude", "mcp.json"), {
			mcpServers: { "fixture-claude-mcp": { command: "true" } },
		});

		const settings = Settings.isolated({});
		const first = await runCustomizeDoctor(cwd, settings);
		const second = await runCustomizeDoctor(cwd, settings);

		const skills = itemsByName(first, "skill");
		expect(skills.get("fixture-native")).toMatchObject({
			sourceClass: "canonical",
			convention: "gjc",
			scope: "project",
			status: "loaded",
			reason: "loaded",
		});
		expect(skills.get("fixture-claude")).toMatchObject({
			sourceClass: "import-candidate",
			convention: "claude-project",
			status: "ignored",
			reason: "source-ignored",
		});
		expect(skills.get("fixture-codex")).toMatchObject({
			sourceClass: "import-candidate",
			convention: "codex-project",
			status: "ignored",
			reason: "source-ignored",
		});

		const mcps = itemsByName(first, "mcp");
		expect(mcps.get("fixture-native-mcp")).toMatchObject({
			sourceClass: "canonical",
			convention: "gjc",
			scope: "project",
		});
		expect(mcps.get("fixture-claude-mcp")).toMatchObject({
			sourceClass: "import-candidate",
			convention: "claude-project",
			status: "ignored",
			reason: "source-ignored",
		});
		// Import candidates are never active runtime authority.
		expect(mcps.get("fixture-claude-mcp")?.mcp?.connectable).toBe(false);

		// Determinism: two runs over the same fixture produce identical reports
		// (modulo the generation timestamp).
		expect(withoutTimestamp(second)).toEqual(withoutTimestamp(first));
	});

	it("redacts secret-bearing MCP fields in both JSON and text output", async () => {
		const cwd = await makeTempProject();
		await writeJson(path.join(cwd, ".gjc", "mcp.json"), {
			mcpServers: {
				"fixture-secret-stdio": {
					command: "run-server",
					args: ["--api-key", "supersecret-value", "--token=abc123token", "--plain", "visible"],
					env: { API_TOKEN: "envsecret-value", MODE: "fast" },
					headers: { Authorization: "Bearer headersecret-value" },
				},
			},
		});

		const report = await runCustomizeDoctor(cwd, Settings.isolated({}));
		const json = renderCustomizeDoctorJson(report);
		const text = renderCustomizeDoctorText(report);

		for (const output of [json, text]) {
			expect(output).not.toContain("supersecret-value");
			expect(output).not.toContain("abc123token");
			expect(output).not.toContain("envsecret-value");
			expect(output).not.toContain("headersecret-value");
			expect(output).toContain("<redacted>");
		}

		const item = itemsByName(report, "mcp").get("fixture-secret-stdio");
		expect(item?.mcp?.args).toEqual(["--api-key", "<redacted>", "--token=<redacted>", "--plain", "visible"]);
		// Env values are never emitted — names only, sorted.
		expect(item?.mcp?.envKeys).toEqual(["API_TOKEN", "MODE"]);
		expect(item?.mcp?.hasHeaders).toBe(true);
	});

	it("emits distinct reason codes for malformed, disabled, shadowed, quarantined, and policy-blocked items", async () => {
		const cwd = await makeTempProject();
		await writeJson(path.join(cwd, ".gjc", "mcp.json"), {
			mcpServers: {
				"fixture-broken": {},
				"fixture-off": { command: "true", enabled: false },
				"fixture-userinfo": { url: "https://user:passphrase@example.com/mcp" },
			},
		});
		// A project copy of a bundled workflow skill name loses to the bundled
		// definition (#4349 invariant) — a deterministic shadowed fixture.
		await makeSkill(path.join(cwd, ".gjc", "skills"), "ralplan", "Project copy of a bundled skill");
		// A quarantined plugin bundle: an enabled entry whose installed file is
		// missing on disk deterministically quarantines every declared surface.
		const pluginRoot = path.join(cwd, ".gjc", "gjc-plugins", "fixture-bundle");
		await writeJson(path.join(cwd, ".gjc", "gjc-plugins", "registry.json"), {
			version: 1,
			scope: "project",
			plugins: [
				{
					name: "fixture-bundle",
					version: "1.0.0",
					scope: "project",
					enabled: true,
					pluginRoot,
					manifestPath: path.join(pluginRoot, "gajae-plugin.json"),
					manifestHash: "",
					source: { kind: "path", uri: pluginRoot, resolvedAt: "2026-01-01T00:00:00.000Z" },
					installedAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					copiedFiles: [{ relativePath: "tools/fixture.ts", sha256: "0".repeat(64), bytes: 1 }],
					surfaces: {
						subskills: [],
						tools: [
							{
								extensionId: "tool:fixture-tool",
								name: "fixture-tool",
								relativePath: "tools/fixture.ts",
								sha256: "0".repeat(64),
							},
						],
						hooks: [],
						mcps: [],
						systemAppendices: [],
						agentAppendices: [],
					},
					disabledSurfaceIds: [],
				},
			],
		});

		const report = await runCustomizeDoctor(cwd, Settings.isolated({}));

		const mcps = itemsByName(report, "mcp");
		expect(mcps.get("fixture-broken")).toMatchObject({ status: "rejected", reason: "invalid-config" });
		expect(mcps.get("fixture-off")).toMatchObject({ status: "disabled", reason: "disabled-server" });
		expect(mcps.get("fixture-userinfo")).toMatchObject({ status: "rejected", reason: "policy-blocked" });
		// The userinfo password is part of the rejected endpoint policy surface;
		// it must never appear in either output format.
		const json = renderCustomizeDoctorJson(report);
		const text = renderCustomizeDoctorText(report);
		expect(json).not.toContain("passphrase");
		expect(text).not.toContain("passphrase");

		// Two items share the name "ralplan": the discovered project copy
		// (shadowed) and the bundled definition (loaded, always authoritative).
		const ralplanCopy = surface(report, "skill").items.find(
			item => item.name === "ralplan" && item.provider !== "bundled" && item.path.startsWith(cwd),
		);
		expect(ralplanCopy).toMatchObject({
			status: "shadowed",
			reason: "shadowed-by-precedence",
			precedence: { shadowedBy: { provider: "bundled", scope: "native" } },
		});

		const bundles = itemsByName(report, "plugin-bundle");
		expect(bundles.get("fixture-bundle")).toMatchObject({ status: "quarantined", reason: "quarantined" });
		expect(bundles.get("fixture-bundle")?.quarantineCode).toBe("runtime_mismatch");

		// Each fixture item is distinguishable by reason alone.
		const reasons = new Set([
			mcps.get("fixture-broken")?.reason,
			mcps.get("fixture-off")?.reason,
			mcps.get("fixture-userinfo")?.reason,
			ralplanCopy?.reason,
			bundles.get("fixture-bundle")?.reason,
		]);
		expect(reasons.size).toBe(5);
	});

	it("reports Function Hook policy metadata without executing hook code", async () => {
		const cwd = await makeTempProject();
		const pluginRoot = path.join(cwd, ".gjc", "gjc-plugins", "function-hook-doctor");
		const hookPath = path.join(pluginRoot, "hooks", "before-read.ts");
		const markerPath = path.join(cwd, "doctor-imported");
		const hookSource = `await Bun.write(${JSON.stringify(markerPath)}, "imported"); export default function() {}`;
		await fs.mkdir(path.dirname(hookPath), { recursive: true });
		await fs.writeFile(hookPath, hookSource);
		await writeJson(path.join(pluginRoot, "gajae-plugin.json"), {
			kind: "gajae-code-plugin",
			name: "function-hook-doctor",
			version: "1.0.0",
			hooks: [
				{
					name: "before-read",
					event: "tool_call",
					target: "read",
					phase: "before",
					path: "hooks/before-read.ts",
					capabilities: ["tool.inspect"],
				},
			],
		});
		const sha256 = createHash("sha256").update(hookSource).digest("hex");
		const grant = normalizeFunctionHookGrant({ capabilities: ["tool.inspect"] });
		await writeJson(path.join(cwd, ".gjc", "gjc-plugins", "registry.json"), {
			version: 1,
			scope: "project",
			plugins: [
				{
					name: "function-hook-doctor",
					version: "1.0.0",
					scope: "project",
					enabled: true,
					pluginRoot,
					manifestPath: path.join(pluginRoot, "gajae-plugin.json"),
					manifestHash: "",
					source: { kind: "path", uri: pluginRoot, resolvedAt: "2026-01-01T00:00:00.000Z" },
					installedAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					copiedFiles: [{ relativePath: "hooks/before-read.ts", sha256, bytes: Buffer.byteLength(hookSource) }],
					surfaces: {
						subskills: [],
						tools: [],
						hooks: [
							{
								extensionId: "hook:tool_call:before:read:before-read",
								name: "before-read",
								event: "tool_call",
								target: "read",
								phase: "before",
								relativePath: "hooks/before-read.ts",
								sha256,
								implementationHash: sha256,
								capabilities: [...grant.capabilities],
								networkDestinations: [],
								filesystemRoots: [],
								capabilityHash: functionHookGrantHash(grant).toUpperCase(),
								functionHook: true,
							},
						],
						mcps: [],
						systemAppendices: [],
						agentAppendices: [],
					},
					disabledSurfaceIds: [],
				},
			],
		});

		const report = await runCustomizeDoctor(cwd, Settings.isolated({}));
		const bundle = itemsByName(report, "plugin-bundle").get("function-hook-doctor");
		expect(bundle?.functionHooks).toEqual([
			expect.objectContaining({
				order: 0,
				event: "tool_call",
				target: "read",
				status: "blocked-isolate",
				requestedCapabilities: ["tool.inspect"],
				effectiveCapabilities: [],
				attenuateDownstream: [],
			}),
		]);
		const text = renderCustomizeDoctorText(report);
		expect(text).toContain("status=blocked-isolate");
		expect(text).toContain("grants: requested=tool.inspect effective=none attenuate=none");
		expect(await Bun.file(markerPath).exists()).toBe(false);
	});

	it("quarantines injected legacy hook grants and redacts unsafe destinations", async () => {
		const cwd = await makeTempProject();
		const pluginRoot = path.join(cwd, ".gjc", "gjc-plugins", "tampered-function-hook");
		const hookPath = path.join(pluginRoot, "hooks", "before-read.ts");
		const manifestPath = path.join(pluginRoot, "gajae-plugin.json");
		const hookSource = "export default function() {}";
		await fs.mkdir(path.dirname(hookPath), { recursive: true });
		await fs.writeFile(hookPath, hookSource);
		await writeJson(manifestPath, {
			kind: "gajae-code-plugin",
			name: "tampered-function-hook",
			version: "1.0.0",
			hooks: [
				{
					name: "before-read",
					event: "tool_call",
					target: "read",
					phase: "before",
					path: "hooks/before-read.ts",
				},
			],
		});
		const sha256 = createHash("sha256").update(hookSource).digest("hex");
		await writeJson(path.join(cwd, ".gjc", "gjc-plugins", "registry.json"), {
			version: 1,
			scope: "project",
			plugins: [
				{
					name: "tampered-function-hook",
					version: "1.0.0",
					scope: "project",
					enabled: true,
					pluginRoot,
					manifestPath,
					manifestHash: "",
					source: { kind: "path", uri: pluginRoot, resolvedAt: "2026-01-01T00:00:00.000Z" },
					installedAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					copiedFiles: [{ relativePath: "hooks/before-read.ts", sha256, bytes: Buffer.byteLength(hookSource) }],
					surfaces: {
						subskills: [],
						tools: [],
						hooks: [
							{
								extensionId: "hook:tool_call:before:read:before-read",
								name: "before-read",
								event: "tool_call",
								target: "write",
								phase: "before",
								relativePath: "hooks/before-read.ts",
								sha256,
								implementationHash: sha256,
								capabilities: ["tool.inspect"],
								networkDestinations: ["https://user:secret@example.com/token?q=secret"],
								filesystemRoots: [],
								capabilityHash: functionHookGrantHash(
									normalizeFunctionHookGrant({ capabilities: ["tool.inspect"] }),
								),
								functionHook: false,
							},
						],
						mcps: [],
						systemAppendices: [],
						agentAppendices: [],
					},
					disabledSurfaceIds: [],
				},
			],
		});

		const report = await runCustomizeDoctor(cwd, Settings.isolated({}));
		const hook = itemsByName(report, "plugin-bundle").get("tampered-function-hook")?.functionHooks?.[0];
		expect(hook).toMatchObject({ status: "quarantined", networkDestinations: ["[redacted]"] });
		expect(JSON.stringify(report)).not.toContain("secret");
	});

	it("agrees with session-startup consumers (loadSkills, loadAllMCPConfigs)", async () => {
		const cwd = await makeTempProject();
		await makeSkill(path.join(cwd, ".gjc", "skills"), "fixture-loaded", "Loaded by startup");
		await makeSkill(path.join(cwd, ".gjc", "skills"), "ultragoal", "Project copy of a bundled skill");
		const aliasDir = path.join(cwd, ".gjc", "skills", "windows-alias");
		await fs.mkdir(aliasDir, { recursive: true });
		await fs.writeFile(
			path.join(aliasDir, "SKILL.md"),
			"---\nname: ralplan.\ndescription: Windows alias of a bundled skill\n---\n\n# Alias\n",
		);
		await makeSkill(path.join(cwd, ".claude", "skills"), "fixture-foreign", "Never loaded by startup");
		await writeJson(path.join(cwd, ".gjc", "mcp.json"), {
			mcpServers: { "fixture-connectable": { command: "true" } },
		});

		const settings = Settings.isolated({});
		const report = await runCustomizeDoctor(cwd, settings);

		// Startup truth: loadSkills with the same settings.
		const startup = await loadSkills({
			...settings.getGroup("skills"),
			cwd,
			disabledExtensions: settings.get("disabledExtensions"),
		});
		const startupNames = new Set(startup.skills.map(s => s.name));

		const skills = itemsByName(report, "skill");
		// A native project skill startup loads is reported loaded...
		expect(startupNames.has("fixture-loaded")).toBe(true);
		expect(skills.get("fixture-loaded")).toMatchObject({ status: "loaded", reason: "loaded" });
		// ...a foreign-convention skill startup never loads is reported ignored...
		expect(startupNames.has("fixture-foreign")).toBe(false);
		expect(skills.get("fixture-foreign")).toMatchObject({ status: "ignored", reason: "source-ignored" });
		// ...and a filesystem copy of a bundled workflow skill name is never the
		// effective session definition (#4349): the doctor must not claim the
		// project copy is active even though loadSkills lists it, and the
		// bundled entry is always loaded.
		const ultragoalCopy = surface(report, "skill").items.find(
			item => item.name === "ultragoal" && item.provider !== "bundled" && item.path.startsWith(cwd),
		);
		expect(ultragoalCopy).toMatchObject({ status: "shadowed", reason: "shadowed-by-precedence" });
		const ralplanAlias = surface(report, "skill").items.find(
			item => item.name === "ralplan." && item.provider !== "bundled",
		);
		expect(ralplanAlias).toMatchObject({ status: "shadowed", reason: "shadowed-by-precedence" });
		const bundled = surface(report, "skill").items.filter(
			item => item.provider === "bundled" && item.name === "ultragoal",
		);
		expect(bundled).toHaveLength(1);
		expect(bundled[0]).toMatchObject({ status: "loaded", reason: "loaded" });

		// MCP startup projection agreement: connectable mirrors loadAllMCPConfigs.
		const projection = await loadAllMCPConfigs(cwd);
		const mcps = itemsByName(report, "mcp");
		const fixture = mcps.get("fixture-connectable");
		expect(Object.keys(projection.configs)).toContain("fixture-connectable");
		expect(fixture?.mcp?.connectable).toBe(true);
		expect(fixture?.status).toBe("stored-only");
	});
	it("disabled native provider does not shadow an enabled lower-priority source (bug A)", async () => {
		const cwd = await makeTempProject();
		// Same skill name from two providers: native (.gjc, priority 100) and
		// agents (.agent, priority 70). When the native provider is disabled,
		// the disabled native must never own the dedup key in the winner map,
		// so the agents item is NOT incorrectly marked shadowed-by-precedence.
		await makeSkill(path.join(cwd, ".gjc", "skills"), "fixture-collision", "Native project skill");
		await makeSkill(path.join(cwd, ".agent", "skills"), "fixture-collision", "Agent project skill");

		const settings = Settings.isolated({
			"skills.enabled": true,
			disabledProviders: ["native"],
		});

		const report = await runCustomizeDoctor(cwd, settings);
		const items = surface(report, "skill").items.filter(i => i.name === "fixture-collision");

		// The native item is listed/reported as disabled-provider.
		const nativeItem = items.find(i => i.provider === "native");
		expect(nativeItem).toMatchObject({
			status: "disabled",
			reason: "disabled-provider",
		});

		// The agents item must NOT be shadowed by the disabled native provider.
		// Without the fix it would report "shadowed-by-precedence" with
		// shadowedBy.provider === "native", which is incorrect: a disabled
		// provider has no effective precedence. With the fix, the agents item
		// reaches its natural classification (source-ignored) instead.
		const agentItem = items.find(i => i.provider === "agents");
		expect(agentItem?.status).not.toBe("shadowed");
		expect(agentItem?.reason).not.toBe("shadowed-by-precedence");
		expect(agentItem?.precedence?.shadowedBy).toBeUndefined();
	});

	it("custom-directory skill collision reports shadowed-by-precedence, not double-loaded (bug B)", async () => {
		const cwd = await makeTempProject();
		// A native skill owns the name first.
		await makeSkill(path.join(cwd, ".gjc", "skills"), "fixture-custom-collision", "Native project skill");
		// A custom directory has a skill of the same name.
		const customDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-custom-skills-"));
		tempDirs.push(customDir);
		await makeSkill(customDir, "fixture-custom-collision", "Custom directory skill");

		const settings = Settings.isolated({
			"skills.enabled": true,
			"skills.customDirectories": [customDir],
		});

		const report = await runCustomizeDoctor(cwd, settings);
		const items = surface(report, "skill").items.filter(i => i.name === "fixture-custom-collision");

		// Exactly one item should be "loaded" (the native one). The custom-
		// directory copy must report shadowed-by-precedence, not a second
		// "loaded" item.
		const loadedItems = items.filter(i => i.status === "loaded");
		expect(loadedItems).toHaveLength(1);
		expect(loadedItems[0]).toMatchObject({ provider: "native", convention: "gjc" });

		const customItem = items.find(i => i.provider === "custom");
		expect(customItem).toMatchObject({
			status: "shadowed",
			reason: "shadowed-by-precedence",
		});
		expect(customItem?.precedence?.shadowedBy).toMatchObject({
			provider: "native",
			scope: "project",
		});

		// Startup agreement: loadSkills only keeps the native copy.
		const startup = await loadSkills({
			...settings.getGroup("skills"),
			cwd,
			disabledExtensions: settings.get("disabledExtensions"),
		});
		const startupSkills = startup.skills.filter(s => s.name === "fixture-custom-collision");
		expect(startupSkills).toHaveLength(1);
		expect(startupSkills[0]?.source).toContain("native");
	});
});
