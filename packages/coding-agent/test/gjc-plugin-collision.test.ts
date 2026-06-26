import { describe, expect, test } from "bun:test";
import {
	GjcPluginLoadError,
	type GjcPluginLoadErrorCode,
	type GjcPluginRegistryEntry,
	type NormalizedGjcPluginBundle,
	type NormalizedGjcPluginSurfaces,
	validateInstallPlan,
} from "../src/extensibility/gjc-plugins";

function surfaces(over: Partial<NormalizedGjcPluginSurfaces> = {}): NormalizedGjcPluginSurfaces {
	return { subskills: [], tools: [], hooks: [], mcps: [], systemAppendices: [], agentAppendices: [], ...over };
}

function bundle(name: string, s: Partial<NormalizedGjcPluginSurfaces>): NormalizedGjcPluginBundle {
	return {
		name,
		version: "1.0.0",
		root: "/tmp/root",
		manifestPath: "/tmp/root/gajae-plugin.json",
		manifestHash: "a".repeat(64),
		surfaces: surfaces(s),
		files: [],
	};
}

function entry(name: string, s: Partial<NormalizedGjcPluginSurfaces>): GjcPluginRegistryEntry {
	return {
		name,
		version: "1.0.0",
		scope: "project",
		enabled: true,
		pluginRoot: `/tmp/${name}`,
		manifestPath: `/tmp/${name}/gajae-plugin.json`,
		manifestHash: "b".repeat(64),
		source: { kind: "path", uri: `/tmp/${name}`, resolvedAt: new Date().toISOString() },
		installedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		copiedFiles: [],
		surfaces: surfaces(s),
		disabledSurfaceIds: [],
	};
}

function expectCode(fn: () => unknown, code: GjcPluginLoadErrorCode): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code}`);
}

describe("GJC plugin install-time collision validation", () => {
	const toolSurface = { extensionId: "tool:dup", name: "dup", relativePath: "t.ts", sha256: "c".repeat(64) };
	const mcpSurface = {
		extensionId: "mcp:docs",
		name: "docs",
		transport: "stdio" as const,
		configHash: "d".repeat(64),
		config: { name: "docs", transport: "stdio" as const, command: "bun", args: ["mcp/s.ts"], cwd: "." },
	};

	test("duplicate tool name across plugins -> duplicate_tool", () => {
		expectCode(
			() => validateInstallPlan(bundle("new", { tools: [toolSurface] }), [entry("old", { tools: [toolSurface] })]),
			"duplicate_tool",
		);
	});

	test("duplicate mcp name across plugins -> duplicate_mcp", () => {
		expectCode(
			() => validateInstallPlan(bundle("new", { mcps: [mcpSurface] }), [entry("old", { mcps: [mcpSurface] })]),
			"duplicate_mcp",
		);
	});

	test("no collision passes", () => {
		expect(() =>
			validateInstallPlan(bundle("new", { tools: [toolSurface] }), [entry("old", { mcps: [mcpSurface] })]),
		).not.toThrow();
	});

	test("same-name self entry is ignored (re-install)", () => {
		expect(() =>
			validateInstallPlan(bundle("same", { tools: [toolSurface] }), [entry("same", { tools: [toolSurface] })]),
		).not.toThrow();
	});
});
