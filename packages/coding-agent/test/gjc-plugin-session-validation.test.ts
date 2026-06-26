import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type GjcPluginRegistryEntry,
	type NormalizedGjcPluginSurfaces,
	validateSessionBundles,
	verifyEntryHashes,
} from "../src/extensibility/gjc-plugins";

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

const tool = (name: string) => ({
	extensionId: `tool:${name}`,
	name,
	relativePath: `${name}.ts`,
	sha256: "b".repeat(64),
});

describe("session validation", () => {
	test("quarantines a plugin tool that collides with a provider tool (no shadowing)", () => {
		const e = entry("p", { surfaces: surfaces({ tools: [tool("read")] }) });
		const res = validateSessionBundles([e], { toolNames: ["read"] });
		expect(res.active).toHaveLength(0);
		expect(res.quarantine[0]?.code).toBe("session_collision");
	});

	test("first plugin wins; second colliding plugin is quarantined", () => {
		const a = entry("a", { surfaces: surfaces({ tools: [tool("dup")] }) });
		const b = entry("b", { surfaces: surfaces({ tools: [tool("dup")] }) });
		const res = validateSessionBundles([a, b]);
		expect(res.active.map(e => e.name)).toEqual(["a"]);
		expect(res.quarantine.map(q => q.plugin)).toEqual(["b"]);
	});

	test("disabled entries and disabled surfaces are skipped without error", () => {
		const disabledEntry = entry("d", { enabled: false, surfaces: surfaces({ tools: [tool("x")] }) });
		const surfaceDisabled = entry("s", {
			surfaces: surfaces({ tools: [tool("y")] }),
			disabledSurfaceIds: ["tool:y"],
		});
		const res = validateSessionBundles([disabledEntry, surfaceDisabled], { toolNames: ["x", "y"] });
		expect(res.quarantine).toHaveLength(0);
		expect(res.active.map(e => e.name)).toEqual(["s"]);
	});

	test("verifyEntryHashes flags drift and missing files", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-drift-"));
		tempDirs.push(root);
		await fs.writeFile(path.join(root, "a.txt"), "original");
		const good = createHash("sha256").update("original").digest("hex");
		const e = entry("drift", {
			pluginRoot: root,
			copiedFiles: [{ relativePath: "a.txt", sha256: good, bytes: 8 }],
		});
		expect(await verifyEntryHashes(e)).toBeNull();

		await fs.writeFile(path.join(root, "a.txt"), "tampered");
		const drift = await verifyEntryHashes(e);
		expect(drift?.code).toBe("runtime_mismatch");

		await fs.rm(path.join(root, "a.txt"));
		const missing = await verifyEntryHashes(e);
		expect(missing?.code).toBe("runtime_mismatch");
	});
});
