import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type GjcPluginRegistryEntry,
	installGjcPluginBundle,
	type NormalizedGjcPluginSurfaces,
	summarizeGjcPluginObservability,
	writeRegistry,
} from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];

afterEach(async () => {
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function mkCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-obs-"));
	tempDirs.push(cwd);
	return cwd;
}

describe("plugin observability summary", () => {
	test("lists every surface with stable extension ids and enabled status", async () => {
		const cwd = await mkCwd();
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		const summary = await summarizeGjcPluginObservability(cwd);
		expect(summary.plugins).toBe(1);
		const ids = summary.surfaces.map(s => s.extensionId);
		expect(ids).toContain("tool:domain_note");
		expect(ids).toContain("hook:tool_call:before:read:audit-read");
		expect(ids).toContain("mcp:domain_docs");
		expect(ids).toContain("system-appendix:valid-six-surface-bundle:domain-policy");
		expect(ids).toContain("agent-appendix:executor:valid-six-surface-bundle:domain-executor");
		expect(ids).toContain("subskill:ralplan:planner:design");
		expect(summary.surfaces.every(s => s.status === "enabled")).toBe(true);
		// No MCP command/url/headers leaked — only id + config hash.
		const mcp = summary.surfaces.find(s => s.kind === "mcp");
		expect(Object.keys(mcp ?? {}).sort()).toEqual(
			["extensionId", "hash", "kind", "plugin", "scope", "sourceKind", "status"].sort(),
		);
	});

	test("marks surfaces quarantined on hash drift", async () => {
		const cwd = await mkCwd();
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		const installed = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle", "tools", "domain-note.ts");
		await fs.appendFile(installed, "\n// tampered\n");
		const summary = await summarizeGjcPluginObservability(cwd);
		expect(summary.surfaces.some(s => s.status === "quarantined" && s.quarantineCode === "runtime_mismatch")).toBe(
			true,
		);
	});

	test("empty summary when no plugins installed", async () => {
		const cwd = await mkCwd();
		const summary = await summarizeGjcPluginObservability(cwd);
		expect(summary).toEqual({ plugins: 0, surfaces: [] });
	});
});

describe("observability quarantine keying", () => {
	function surfaces(over: Partial<NormalizedGjcPluginSurfaces> = {}): NormalizedGjcPluginSurfaces {
		return { subskills: [], tools: [], hooks: [], mcps: [], systemAppendices: [], agentAppendices: [], ...over };
	}
	function entry(name: string): GjcPluginRegistryEntry {
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
			surfaces: surfaces({
				tools: [{ extensionId: "tool:dup", name: "dup", relativePath: "t.ts", sha256: "b".repeat(64) }],
			}),
			disabledSurfaceIds: [],
		};
	}

	test("session-collision quarantines only the colliding plugin, not the first", async () => {
		const cwd = await mkCwd();
		await fs.mkdir(path.join(cwd, ".gjc", "gjc-plugins"), { recursive: true });
		// Two entries share extension id tool:dup; the second collides.
		await writeRegistry({ version: 1, scope: "project", plugins: [entry("a"), entry("b")] }, cwd);
		const summary = await summarizeGjcPluginObservability(cwd);
		const a = summary.surfaces.find(s => s.plugin === "a" && s.extensionId === "tool:dup");
		const b = summary.surfaces.find(s => s.plugin === "b" && s.extensionId === "tool:dup");
		expect(a?.status).toBe("enabled");
		expect(b?.status).toBe("quarantined");
		expect(b?.quarantineCode).toBe("session_collision");
	});
});
