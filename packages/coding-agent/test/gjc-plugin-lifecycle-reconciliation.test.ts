import { describe, expect, test } from "bun:test";
import {
	activationFingerprint,
	bundleIdentity,
	candidateFingerprint,
	decisionContextFingerprint,
	diffSurfaceIds,
	type GjcPluginRegistryEntry,
	identityEquals,
	identityKey,
	type NormalizedGjcPluginBundle,
	type NormalizedGjcPluginSurfaces,
	reconcileEnablement,
	surfaceIdsOf,
	targetFingerprint,
} from "../src/extensibility/gjc-plugins";

const surfaces: NormalizedGjcPluginSurfaces = {
	subskills: [
		{
			extensionId: "subskill",
			name: "subskill",
			description: "",
			parent: "executor",
			phase: "prompt",
			activationArg: "go",
			relativePath: "subskill.md",
			sha256: "a",
		},
	],
	tools: [{ extensionId: "tool", name: "tool", relativePath: "tool.ts", sha256: "b" }],
	hooks: [{ extensionId: "hook", name: "hook", event: "tool_call", relativePath: "hook.ts", sha256: "c" }],
	mcps: [
		{
			extensionId: "mcp",
			name: "mcp",
			transport: "stdio",
			configHash: "d",
			config: { name: "mcp", transport: "stdio" },
		},
	],
	systemAppendices: [{ extensionId: "appendix", name: "appendix", content: "", contentHash: "e", bytes: 0 }],
	agentAppendices: [
		{ extensionId: "agent", name: "agent", agent: "executor", content: "", contentHash: "f", bytes: 0 },
	],
};

function bundle(
	version = "1.0.0",
	manifestHash = "manifest",
	files = [{ relativePath: "file", sha256: "file-hash", bytes: 1 }],
): NormalizedGjcPluginBundle {
	return {
		name: "bundle",
		version,
		root: "/source",
		manifestPath: "/source/gajae-plugin.json",
		manifestHash,
		surfaces,
		files,
	};
}

function entry(scope: "project" | "user" = "project", name = "bundle"): GjcPluginRegistryEntry {
	return {
		name,
		version: "1.0.0",
		scope,
		enabled: true,
		pluginRoot: "/installed",
		manifestPath: "/installed/gajae-plugin.json",
		manifestHash: "manifest",
		source: { kind: "path", uri: "/source", resolvedAt: "2026-01-01T00:00:00.000Z" },
		installedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		copiedFiles: [{ relativePath: "file", sha256: "file-hash", bytes: 1 }],
		surfaces,
		disabledSurfaceIds: [],
	};
}

describe("GJC bundle lifecycle reconciliation", () => {
	test("collects sorted unique IDs across every surface kind", () => {
		const duplicate = { ...surfaces, tools: [...surfaces.tools, { ...surfaces.tools[0] }] };
		expect(surfaceIdsOf(duplicate)).toEqual(["agent", "appendix", "hook", "mcp", "subskill", "tool"]);
	});

	test("fingerprints are deterministic and include version, manifest, surfaces, files, and scope", () => {
		const initial = bundle();
		expect(candidateFingerprint("project", initial)).toBe(candidateFingerprint("project", initial));
		expect(targetFingerprint(entry())).toBe(targetFingerprint(entry()));
		expect(candidateFingerprint("project", initial)).not.toBe(candidateFingerprint("user", initial));
		expect(candidateFingerprint("project", initial)).not.toBe(candidateFingerprint("project", bundle("2.0.0")));
		expect(candidateFingerprint("project", initial)).not.toBe(
			candidateFingerprint("project", bundle("1.0.0", "other-manifest")),
		);
		expect(candidateFingerprint("project", initial)).not.toBe(
			candidateFingerprint("project", { ...initial, surfaces: { ...surfaces, tools: [] } }),
		);
		expect(candidateFingerprint("project", initial)).not.toBe(
			candidateFingerprint(
				"project",
				bundle("1.0.0", "manifest", [{ relativePath: "file", sha256: "other-file-hash", bytes: 1 }]),
			),
		);
	});

	test("decision context observes opposite-scope entries and ignores input order", () => {
		const target = bundleIdentity("project", "bundle");
		const opposite = entry("user");
		const base = decisionContextFingerprint(target, [entry()]);
		const withOpposite = decisionContextFingerprint(target, [entry(), opposite]);
		expect(withOpposite).not.toBe(base);
		expect(decisionContextFingerprint(target, [opposite, entry()])).toBe(withOpposite);
		expect(decisionContextFingerprint(target, [entry(), { ...opposite, enabled: false }])).not.toBe(withOpposite);
	});

	test("activation fingerprint ignores disabled bundles but observes surface intent and quarantine", () => {
		const active = entry();
		const disabled = { ...entry("user", "disabled"), enabled: false };
		const baseline = activationFingerprint([active, disabled]);
		expect(activationFingerprint([disabled, active])).toBe(baseline);
		expect(activationFingerprint([active])).toBe(baseline);
		expect(activationFingerprint([{ ...active, disabledSurfaceIds: ["tool"] }])).not.toBe(baseline);
		expect(
			activationFingerprint([
				{
					...active,
					quarantine: [{ surfaceId: "tool", code: "runtime_mismatch", message: "bad", detectedAt: "now" }],
				},
			]),
		).not.toBe(baseline);
	});

	test("reconciles persisted enablement and quarantine against candidate surfaces", () => {
		// Quarantine is recomputed from the candidate's own justified findings;
		// stale records for surfaces the candidate fixed are never carried over.
		const result = reconcileEnablement(
			["tool", "removed", "tool"],
			["new", "tool"],
			[
				{ surfaceId: "tool", code: "runtime_mismatch", message: "first", detectedAt: "1" },
				{ surfaceId: "tool", code: "runtime_mismatch", message: "duplicate", detectedAt: "2" },
				{ surfaceId: "removed", code: "runtime_mismatch", message: "gone", detectedAt: "3" },
			],
		);
		expect(result.disabledSurfaceIds).toEqual(["tool"]);
		expect(result.quarantine).toEqual([
			{ surfaceId: "tool", code: "runtime_mismatch", message: "first", detectedAt: "1" },
		]);
	});

	test("diffs surface IDs into sorted added, removed, and retained sets", () => {
		expect(diffSurfaceIds(["z", "retained", "removed"], ["added", "retained", "z"])).toEqual({
			addedSurfaceIds: ["added"],
			removedSurfaceIds: ["removed"],
			retainedSurfaceIds: ["retained", "z"],
		});
	});

	test("identity equality and keys include scope and name", () => {
		const project = bundleIdentity("project", "bundle");
		expect(identityEquals(project, bundleIdentity("project", "bundle"))).toBe(true);
		expect(identityEquals(project, bundleIdentity("user", "bundle"))).toBe(false);
		expect(identityEquals(project, bundleIdentity("project", "other"))).toBe(false);
		expect(identityKey(project)).not.toBe(identityKey(bundleIdentity("user", "bundle")));
		expect(identityKey(project)).not.toBe(identityKey(bundleIdentity("project", "other")));
	});
});
