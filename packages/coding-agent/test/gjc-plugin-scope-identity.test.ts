import { describe, expect, test } from "bun:test";
import {
	bundleIdentity,
	GjcPluginLoadError,
	type GjcPluginRegistryEntry,
	type NormalizedGjcPluginBundle,
	type NormalizedGjcPluginSurfaces,
	reconcileEnablement,
	validateInstallPlan,
	validateSessionBundles,
} from "../src/extensibility/gjc-plugins";

function surfaces(over: Partial<NormalizedGjcPluginSurfaces> = {}): NormalizedGjcPluginSurfaces {
	return { subskills: [], tools: [], hooks: [], mcps: [], systemAppendices: [], agentAppendices: [], ...over };
}

function entry(
	scope: "user" | "project",
	name: string,
	s: Partial<NormalizedGjcPluginSurfaces> = {},
): GjcPluginRegistryEntry {
	return {
		name,
		version: "1.0.0",
		scope,
		enabled: true,
		pluginRoot: `/tmp/${scope}-${name}`,
		manifestPath: `/tmp/${scope}-${name}/gajae-plugin.json`,
		manifestHash: "a".repeat(64),
		source: { kind: "path", uri: `/tmp/${scope}-${name}`, resolvedAt: "2026-01-01T00:00:00.000Z" },
		installedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		copiedFiles: [],
		surfaces: surfaces(s),
		disabledSurfaceIds: [],
	};
}

function bundle(name: string, s: Partial<NormalizedGjcPluginSurfaces>): NormalizedGjcPluginBundle {
	return {
		name,
		version: "1.0.0",
		root: "/tmp/source",
		manifestPath: "/tmp/source/gajae-plugin.json",
		manifestHash: "b".repeat(64),
		surfaces: surfaces(s),
		files: [],
	};
}

describe("GJC plugin scope-qualified identities", () => {
	test("pre-quarantine for user/foo does not suppress project/foo", () => {
		const projectFoo = entry("project", "foo");
		const result = validateSessionBundles([projectFoo], {}, [
			{
				identity: bundleIdentity("user", "foo"),
				plugin: "foo",
				surfaceId: "plugin:foo",
				code: "runtime_mismatch",
				message: "user bundle drifted",
			},
		]);

		expect(result.active).toEqual([projectFoo]);
	});

	test("install validation keeps the supported dual-scope same-name install legal", () => {
		const tool = { extensionId: "tool:shared", name: "shared", relativePath: "tool.ts", sha256: "c".repeat(64) };
		// Surface IDs derive from the bundle name, so the SAME bundle installed
		// into both scopes necessarily shares them. Production passes only the
		// target scope's registry, so this must not be an install-time collision;
		// otherwise the supported dual-scope install would be self-colliding.
		expect(() => validateInstallPlan(bundle("foo", { tools: [tool] }), [])).not.toThrow();

		// The same bundle already installed in the opposite scope is the same
		// logical bundle, so its surfaces are not collisions against itself.
		expect(() =>
			validateInstallPlan(bundle("foo", { tools: [tool] }), [entry("user", "foo", { tools: [tool] })]),
		).not.toThrow();

		// A DIFFERENTLY named bundle in the opposite scope claiming the same
		// surface ID is a genuine collision and must fail closed at install time.
		expect(() =>
			validateInstallPlan(bundle("foo", { tools: [tool] }), [entry("user", "other", { tools: [tool] })]),
		).toThrow(GjcPluginLoadError);
	});

	test("runtime fail-closes on a cross-scope collision install validation allows", () => {
		// This is the real defense for dual-scope same-name bundles: install-time
		// validation is per-scope, and the session validator sees both scopes and
		// quarantines the collision rather than letting two bundles shadow.
		const tool = { extensionId: "tool:shared", name: "shared", relativePath: "tool.ts", sha256: "c".repeat(64) };
		const result = validateSessionBundles([
			entry("user", "foo", { tools: [tool] }),
			entry("project", "foo", { tools: [tool] }),
		]);
		expect(result.active).toHaveLength(1);
		expect(result.quarantine).toHaveLength(1);
		expect(result.quarantine[0]).toMatchObject({ code: "session_collision", surfaceId: "tool:shared" });
	});

	test("recomputes candidate quarantine while retaining enablement intent", () => {
		const result = reconcileEnablement(
			["disabled", "removed", "disabled"],
			["disabled", "fixed", "kept", "new"],
			[
				{ surfaceId: "kept", code: "runtime_mismatch", message: "still bad", detectedAt: "2" },
				{ surfaceId: "kept", code: "runtime_mismatch", message: "duplicate", detectedAt: "3" },
				{ surfaceId: "removed", code: "runtime_mismatch", message: "not a candidate surface", detectedAt: "4" },
			],
		);

		expect(result.disabledSurfaceIds).toEqual(["disabled"]);
		expect(result.quarantine).toEqual([
			{ surfaceId: "kept", code: "runtime_mismatch", message: "still bad", detectedAt: "2" },
		]);
	});
});
