import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { installGjcBundle, loadAlwaysOnPluginTools, renderSkillAdvertisement } from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];
const originalAgentDir = getAgentDir();
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-runtime-adapters-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

async function mkCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-rt-"));
	tempDirs.push(cwd);
	return cwd;
}

describe("always-on plugin tool runtime activation", () => {
	test("loads a declared always-on tool from an installed bundle", async () => {
		const cwd = await mkCwd();
		const r = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(r.ok).toBe(true);
		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(res.tools.map(t => t.name)).toContain("domain_note");
		expect(res.quarantine).toHaveLength(0);
	});

	test("returns nothing when no plugins are installed", async () => {
		const cwd = await mkCwd();
		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(res.tools).toHaveLength(0);
		expect(res.quarantine).toHaveLength(0);
	});

	test("refuses to overwrite a reserved tool name", async () => {
		const cwd = await mkCwd();
		const r = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(r.ok).toBe(true);
		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: ["domain_note"] });
		expect(res.tools.map(t => t.name)).not.toContain("domain_note");
		expect(res.quarantine.some(q => q.code === "session_collision")).toBe(true);
	});

	test("quarantines on installed-file hash drift", async () => {
		const cwd = await mkCwd();
		const r = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(r.ok).toBe(true);
		const installed = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle", "tools", "domain-note.ts");
		await fs.appendFile(installed, "\n// tampered after install\n");
		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(res.tools.map(t => t.name)).not.toContain("domain_note");
		expect(res.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
	});
	test("rechecks each always-on tool immediately before its import", async () => {
		const cwd = await mkCwd();
		const source = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-runtime-race-source-"));
		tempDirs.push(source);
		await fs.cp(sixSurface, source, { recursive: true });
		const lateTool = path.join(source, "tools", "late.ts");
		await fs.writeFile(
			lateTool,
			`import * as fs from "node:fs";
if (process.env.GJC_LATE_IMPORT_SENTINEL) fs.writeFileSync(process.env.GJC_LATE_IMPORT_SENTINEL, "imported");
export default pi => ({ name: "late_tool", label: "Late", description: "late", parameters: pi.zod.object({}), async execute() { return { content: [{ type: "text", text: "late" }] }; } });
`,
		);
		const manifestPath = path.join(source, "gajae-plugin.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.tools = [
			...(manifest.tools as unknown[]),
			{ name: "late_tool", path: "tools/late.ts", description: "late" },
		];
		await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		const installed = await installGjcBundle({ cwd }, "project", source);
		expect(installed.ok).toBe(true);
		const lateSentinel = path.join(cwd, "late-imported");
		process.env.GJC_LATE_IMPORT_SENTINEL = lateSentinel;
		try {
			let mutated = false;
			const result = await loadAlwaysOnPluginTools({
				cwd,
				reservedToolNames: [],
				beforeImport: async resolvedPath => {
					if (mutated || !resolvedPath.endsWith("domain-note.ts")) return;
					mutated = true;
					await fs.appendFile(
						path.join(path.dirname(resolvedPath), "late.ts"),
						"\n// changed after batch verification\n",
					);
				},
			});
			expect(result.tools.map(tool => tool.name)).toContain("domain_note");
			expect(result.tools.map(tool => tool.name)).not.toContain("late_tool");
			expect(
				result.quarantine.some(item => item.code === "runtime_mismatch" && item.surfaceId.includes("late_tool")),
			).toBe(true);
			expect(
				await fs
					.stat(lateSentinel)
					.then(() => true)
					.catch(() => false),
			).toBe(false);
		} finally {
			delete process.env.GJC_LATE_IMPORT_SENTINEL;
		}
	});

	test("quarantines runtime_mismatch when factory name != declared name", async () => {
		const cwd = await mkCwd();
		const src = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-mismatch-"));
		tempDirs.push(src);
		await fs.mkdir(path.join(src, "tools"), { recursive: true });
		await fs.writeFile(
			path.join(src, "tools", "t.ts"),
			"export default function (pi){return {name:'actual_y',label:'X',description:'x',parameters:pi.typebox.Type.Object({}),async execute(){return {content:[{type:'text',text:'ok'}]};}};}\n",
		);
		await fs.writeFile(
			path.join(src, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "mismatch-bundle",
				version: "1.0.0",
				tools: [{ name: "declared_x", path: "tools/t.ts" }],
			}),
		);
		const r = await installGjcBundle({ cwd }, "project", src);
		expect(r.ok).toBe(true);
		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(res.tools.map(t => t.name)).not.toContain("actual_y");
		expect(res.tools.map(t => t.name)).not.toContain("declared_x");
		expect(res.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
	});

	test("reuses validated registry hashes across repeated surface calls until files change", async () => {
		const cwd = await mkCwd();
		const r = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(r.ok).toBe(true);
		const installedRoot = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle");
		const openSpy = spyOn(fs, "open");
		const pluginReadCount = () =>
			openSpy.mock.calls.filter(args => typeof args[0] === "string" && args[0].startsWith(installedRoot)).length;

		try {
			const first = await renderSkillAdvertisement({ cwd, skillName: "ralplan", phase: "planner" });
			expect(first).toContain('activation_arg="design"');
			const afterFirst = pluginReadCount();
			expect(afterFirst).toBeGreaterThan(0);

			const second = await renderSkillAdvertisement({ cwd, skillName: "ralplan", phase: "planner" });
			expect(second).toContain('activation_arg="design"');
			expect(pluginReadCount()).toBe(afterFirst);
		} finally {
			openSpy.mockRestore();
		}
	});

	test("file metadata changes force re-hash and drift quarantine", async () => {
		const cwd = await mkCwd();
		const r = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(r.ok).toBe(true);
		const installed = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle", "tools", "domain-note.ts");
		const installedRoot = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle");
		const openSpy = spyOn(fs, "open");
		const pluginReadCount = () =>
			openSpy.mock.calls.filter(args => typeof args[0] === "string" && args[0].startsWith(installedRoot)).length;

		try {
			await renderSkillAdvertisement({ cwd, skillName: "ralplan", phase: "planner" });
			const afterPriming = pluginReadCount();
			await fs.appendFile(installed, "\n// tampered after cache priming\n");

			const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
			expect(pluginReadCount()).toBeGreaterThan(afterPriming);
			expect(res.tools.map(t => t.name)).not.toContain("domain_note");
			expect(res.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
		} finally {
			openSpy.mockRestore();
		}
	});

	test("same-size tamper with restored mtime still fails closed instead of reusing a forged hash", async () => {
		const cwd = await mkCwd();
		const r = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(r.ok).toBe(true);
		const installed = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle", "tools", "domain-note.ts");
		const beforeStat = await fs.stat(installed);
		const primed = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(primed.tools.map(t => t.name)).toContain("domain_note");

		const original = await fs.readFile(installed, "utf8");
		const tampered = original.replace('label: "Domain Note"', 'label: "Domain Nope"');
		expect(tampered).not.toBe(original);
		expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original));
		await fs.writeFile(installed, tampered);
		await fs.utimes(installed, beforeStat.atime, beforeStat.mtime);

		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(res.tools.map(t => t.name)).not.toContain("domain_note");
		expect(res.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
	});

	test("registry enablement changes invalidate the validated-registry cache", async () => {
		const cwd = await mkCwd();
		const r = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(r.ok).toBe(true);
		const before = await renderSkillAdvertisement({ cwd, skillName: "ralplan", phase: "planner" });
		expect(before).toContain('activation_arg="design"');

		const registryPath = path.join(cwd, ".gjc", "gjc-plugins", "registry.json");
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
		registry.plugins[0].enabled = false;
		await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

		const after = await renderSkillAdvertisement({ cwd, skillName: "ralplan", phase: "planner" });
		expect(after).toBe("");
	});
});
