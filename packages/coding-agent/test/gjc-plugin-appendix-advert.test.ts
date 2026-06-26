import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildAgentSubskillAdvertisement,
	buildSubskillAdvertisement,
	type GjcPluginRegistryEntry,
	installGjcPluginBundle,
	loadEffectiveGjcPluginRegistry,
	type NormalizedGjcPluginSurfaces,
	renderPluginAppendices,
} from "../src/extensibility/gjc-plugins";
import { buildSystemPrompt } from "../src/system-prompt";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];

afterEach(async () => {
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

function surfaces(over: Partial<NormalizedGjcPluginSurfaces> = {}): NormalizedGjcPluginSurfaces {
	return { subskills: [], tools: [], hooks: [], mcps: [], systemAppendices: [], agentAppendices: [], ...over };
}

function entry(name: string, over: Partial<GjcPluginRegistryEntry> = {}): GjcPluginRegistryEntry {
	return {
		name,
		version: "1.0.0",
		scope: "project",
		enabled: true,
		pluginRoot: `/tmp/${name}`,
		manifestPath: `/tmp/${name}/gajae-plugin.json`,
		manifestHash: "a".repeat(64),
		source: { kind: "path", uri: `/tmp/${name}`, resolvedAt: new Date().toISOString() },
		installedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		copiedFiles: [],
		surfaces: surfaces(),
		disabledSurfaceIds: [],
		...over,
	};
}

describe("plugin prompt appendices", () => {
	test("renders lower-authority system + agent appendix blocks from an installed bundle", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-appx-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		const effective = await loadEffectiveGjcPluginRegistry(cwd);
		const rendered = await renderPluginAppendices(effective);
		expect(rendered.system).toContain("<gjc-plugin-system-appendix");
		expect(rendered.system).toContain('authority="appendix-lower-than-system"');
		expect(rendered.system).toContain("Domain policy");
		expect(rendered.byAgent.get("executor")).toContain("<gjc-plugin-agent-appendix");
		expect(rendered.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	test("digest changes when appendix content changes", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-appx2-"));
		tempDirs.push(cwd);
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		const before = (await renderPluginAppendices(await loadEffectiveGjcPluginRegistry(cwd))).digest;
		const modified = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-appx-mod-"));
		tempDirs.push(modified);
		await fs.cp(sixSurface, modified, { recursive: true });
		await fs.appendFile(path.join(modified, "prompts", "system-appendix.md"), "\nNew clause.\n");
		await installGjcPluginBundle(modified, { scope: "project", cwd, force: true });
		const after = (await renderPluginAppendices(await loadEffectiveGjcPluginRegistry(cwd))).digest;
		expect(after).not.toBe(before);
	});
});

describe("Tier-1 subskill advertisement", () => {
	const sub = (over: object) => ({
		extensionId: `subskill:ralplan:planner:${(over as { activationArg?: string }).activationArg ?? "x"}`,
		name: "design",
		description: "Adds domain design guidance",
		parent: "ralplan",
		phase: "planner",
		activationArg: "design",
		relativePath: "s.md",
		sha256: "b".repeat(64),
		...over,
	});

	test("renders bounded metadata-only block for the target parent", () => {
		const e = entry("p", { surfaces: surfaces({ subskills: [sub({})] }) });
		const block = buildSubskillAdvertisement([e], "ralplan", "planner");
		expect(block).toContain("<gjc-plugin-subskill-advertisement");
		expect(block).toContain('activation_arg="design"');
		expect(block).not.toContain("<gjc-subskill"); // no Tier-2 body
	});

	test("returns empty for a parent with no bound subskills", () => {
		const e = entry("p", { surfaces: surfaces({ subskills: [sub({})] }) });
		expect(buildSubskillAdvertisement([e], "deep-interview")).toBe("");
		expect(buildAgentSubskillAdvertisement([e], "executor")).toBe("");
	});

	test("caps the number of advertised items and notes the overflow", () => {
		const subs = Array.from({ length: 20 }, (_, i) =>
			sub({ activationArg: `a${i}`, extensionId: `subskill:ralplan:planner:a${i}` }),
		);
		const e = entry("p", { surfaces: surfaces({ subskills: subs }) });
		const block = buildSubskillAdvertisement([e], "ralplan", "planner");
		expect(block).toContain("additional plugin sub-skill(s) omitted");
	});
});

describe("system prompt appendix integration", () => {
	test("buildSystemPrompt appends plugin appendices as a trailing lower-authority block", async () => {
		const block =
			'<gjc-plugin-system-appendix plugin="p" name="x" authority="appendix-lower-than-system">domain policy text</gjc-plugin-system-appendix>';
		const res = await buildSystemPrompt({ cwd: process.cwd(), pluginAppendices: block });
		const joined = res.systemPrompt.join("\n\n");
		expect(joined).toContain("<gjc-plugin-system-appendix");
		expect(joined).toContain("domain policy text");
		// Appendix is last (lower authority than everything above it).
		expect(joined.trimEnd().endsWith("</gjc-plugin-system-appendix>")).toBe(true);
	});

	test("buildSystemPrompt omits the appendix block when none provided", async () => {
		const res = await buildSystemPrompt({ cwd: process.cwd() });
		expect(res.systemPrompt.join("\n\n")).not.toContain("<gjc-plugin-system-appendix");
	});
});

describe("M5 blocker fixes", () => {
	test("renders inline-content appendices (not just file-backed)", async () => {
		const e = entry("inline-plugin", {
			surfaces: surfaces({
				systemAppendices: [
					{
						extensionId: "system-appendix:inline-plugin:policy",
						name: "policy",
						content: "INLINE-POLICY-BODY",
						contentHash: "c".repeat(64),
						bytes: 18,
					},
				],
			}),
		});
		const rendered = await renderPluginAppendices([e]);
		expect(rendered.system).toContain("INLINE-POLICY-BODY");
	});

	test("parseManifest rejects unknown agent-appendix agent with invalid_parent", async () => {
		const { GjcPluginLoadError, parseManifest } = await import("../src/extensibility/gjc-plugins");
		try {
			parseManifest(
				{
					kind: "gajae-code-plugin",
					name: "bad-agent",
					version: "1.0.0",
					"agent-appendix": [{ agent: "reviewer", name: "x", path: "p.md" }],
				},
				"/plugin/gajae-plugin.json",
			);
			throw new Error("expected invalid_parent");
		} catch (error) {
			expect(error).toBeInstanceOf(GjcPluginLoadError);
			expect((error as InstanceType<typeof GjcPluginLoadError>).code).toBe("invalid_parent");
		}
	});
});
