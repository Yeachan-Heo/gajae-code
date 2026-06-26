import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	compileGjcPluginBundle,
	GjcPluginLoadError,
	type GjcPluginLoadErrorCode,
	type GjcPluginRegistryEntry,
	parseManifest,
	readRegistry,
	updateRegistry,
} from "../src/extensibility/gjc-plugins";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

function expectLoadError(fn: () => unknown, code: GjcPluginLoadErrorCode): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code} load error`);
}

async function expectCompileError(root: string, code: GjcPluginLoadErrorCode): Promise<void> {
	try {
		await compileGjcPluginBundle(root);
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code} compile error`);
}

async function expectCompileErrorOneOf(root: string, codes: GjcPluginLoadErrorCode[]): Promise<void> {
	try {
		await compileGjcPluginBundle(root);
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect(codes).toContain((error as GjcPluginLoadError).code);
		return;
	}
	throw new Error(`Expected one of ${codes.join(", ")} compile errors`);
}

async function expectReadRegistryError(cwd: string, code: GjcPluginLoadErrorCode): Promise<void> {
	try {
		await readRegistry("project", cwd);
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		expect((error as GjcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code} registry error`);
}

async function makeTempPlugin(prefix: string, manifest: Record<string, unknown>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	await fs.writeFile(path.join(dir, "gajae-plugin.json"), JSON.stringify(manifest));
	return dir;
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "gajae-code-plugin",
		name: "redteam",
		version: "1.0.0",
		...overrides,
	};
}

function registryEntry(name: string, cwd: string): GjcPluginRegistryEntry {
	const pluginRoot = path.join(cwd, "plugins", name);
	return {
		name,
		version: "1.0.0",
		scope: "project",
		enabled: true,
		pluginRoot,
		manifestPath: path.join(pluginRoot, "gajae-plugin.json"),
		manifestHash: name.padEnd(64, "a").slice(0, 64),
		source: { kind: "path", uri: pluginRoot, resolvedAt: new Date().toISOString() },
		installedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		copiedFiles: [{ relativePath: "gajae-plugin.json", sha256: "a".repeat(64), bytes: 1 }],
		surfaces: {
			subskills: [],
			tools: [],
			hooks: [],
			mcps: [],
			systemAppendices: [],
			agentAppendices: [],
		},
		disabledSurfaceIds: [],
	};
}

describe("GJC plugin Milestone 1 red-team QA", () => {
	test("rejects manifest injection, forbidden top-level surfaces, MCP aliases, and malformed surface shapes", () => {
		const cases: Array<[string, Record<string, unknown>, GjcPluginLoadErrorCode]> = [
			["unknown surface key", { rootkit: [] }, "unsupported_surface"],
			["forbidden agents", { agents: [{ name: "evil" }] }, "forbidden_surface"],
			["forbidden skills", { skills: [{ name: "evil" }] }, "forbidden_surface"],
			["forbidden commands", { commands: [{ name: "evil" }] }, "forbidden_surface"],
			["forbidden slash commands", { "slash-commands": [{ name: "evil" }] }, "forbidden_surface"],
			["legacy mcp alias", { mcp: { command: "node" } }, "unsupported_surface"],
			["legacy mcpServers alias", { mcpServers: { docs: { command: "node" } } }, "unsupported_surface"],
			["hooks not array", { hooks: { name: "audit" } }, "invalid_manifest"],
			["hooks entry not object", { hooks: ["hooks/audit.ts"] }, "invalid_manifest"],
			["mcps not array", { mcps: { name: "docs" } }, "invalid_manifest"],
			["mcps entry not object", { mcps: ["docs"] }, "invalid_manifest"],
			["system appendix not array", { system_appendix: { name: "policy" } }, "invalid_manifest"],
			["system appendix entry not object", { system_appendix: ["prompts/policy.md"] }, "invalid_manifest"],
			["agent appendix not array", { "agent-appendix": { agent: "executor" } }, "invalid_manifest"],
			["agent appendix entry not object", { "agent-appendix": ["prompts/agent.md"] }, "invalid_manifest"],
		];

		for (const [label, overrides, code] of cases) {
			expectLoadError(() => parseManifest(baseManifest(overrides), `redteam-${label}.json`), code);
		}
	});

	test("rejects traversal paths and never imports plugin code while compiling", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-redteam-traversal-"));
		tempDirs.push(dir);
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-redteam-outside-"));
		tempDirs.push(outside);
		const sentinel = path.join(outside, "sentinel.txt");
		await fs.mkdir(path.join(dir, "tools"), { recursive: true });
		await fs.writeFile(
			path.join(dir, "tools", "sentinel.ts"),
			`import * as fs from "node:fs"; fs.writeFileSync(process.env.GJC_TEST_IMPORT_SENTINEL!, "imported");\n`,
		);
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify(baseManifest({ tools: [{ name: "sentinel", path: "tools/sentinel.ts" }] })),
		);
		const prev = process.env.GJC_TEST_IMPORT_SENTINEL;
		process.env.GJC_TEST_IMPORT_SENTINEL = sentinel;
		try {
			await compileGjcPluginBundle(dir);
		} finally {
			if (prev === undefined) delete process.env.GJC_TEST_IMPORT_SENTINEL;
			else process.env.GJC_TEST_IMPORT_SENTINEL = prev;
		}
		await expect(fs.access(sentinel)).rejects.toThrow();

		const traversalCases: Array<[string, Record<string, unknown>]> = [
			["subskill traversal", { subskills: ["../outside/SKILL.md"] }],
			["tool traversal", { tools: [{ name: "escape", path: "../outside/tool.ts" }] }],
			["hook traversal", { hooks: [{ name: "escape", event: "tool_call", path: "../outside/hook.ts" }] }],
			["system appendix traversal", { system_appendix: [{ name: "escape", path: "../outside/policy.md" }] }],
			[
				"agent appendix traversal",
				{ "agent-appendix": [{ agent: "executor", name: "escape", path: "../outside/agent.md" }] },
			],
		];
		for (const [label, overrides] of traversalCases) {
			const root = await makeTempPlugin(`gjc-redteam-${label.replaceAll(" ", "-")}-`, baseManifest(overrides));
			await expectCompileError(root, "missing_file");
		}
	});

	test("rejects a symlink that resolves outside the plugin root", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-redteam-symlink-"));
		tempDirs.push(dir);
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-redteam-symlink-outside-"));
		tempDirs.push(outside);
		await fs.writeFile(path.join(outside, "policy.md"), "outside policy\n");
		await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
		await fs.symlink(path.join(outside, "policy.md"), path.join(dir, "prompts", "policy.md"));
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify(baseManifest({ system_appendix: [{ name: "escape", path: "prompts/policy.md" }] })),
		);
		await expectCompileErrorOneOf(dir, ["missing_file", "security_policy"]);
	});

	test("rejects declared sha256 tampering", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-redteam-hash-"));
		tempDirs.push(dir);
		await fs.mkdir(path.join(dir, "tools"), { recursive: true });
		await fs.writeFile(path.join(dir, "tools", "note.ts"), "export const note = 'safe';\n");
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify(baseManifest({ tools: [{ name: "note", path: "tools/note.ts", sha256: "0".repeat(64) }] })),
		);
		await expectCompileError(dir, "hash_mismatch");
	});

	test("rejects appendix abuse with both path and content, neither, or empty content", async () => {
		const both = await makeTempPlugin(
			"gjc-redteam-appendix-both-",
			baseManifest({ system_appendix: [{ name: "policy", path: "prompts/policy.md", content: "inline" }] }),
		);
		await expectCompileError(both, "invalid_appendix");

		const neither = await makeTempPlugin(
			"gjc-redteam-appendix-neither-",
			baseManifest({ system_appendix: [{ name: "policy" }] }),
		);
		await expectCompileError(neither, "invalid_appendix");

		const emptyInline = await makeTempPlugin(
			"gjc-redteam-appendix-empty-",
			baseManifest({ "agent-appendix": [{ agent: "executor", name: "policy", content: "   \n\t" }] }),
		);
		await expectCompileError(emptyInline, "invalid_appendix");
	});

	test("reports corrupt registry JSON as invalid_manifest", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-redteam-corrupt-registry-"));
		tempDirs.push(cwd);
		const registryDir = path.join(cwd, ".gjc", "gjc-plugins");
		await fs.mkdir(registryDir, { recursive: true });
		await fs.writeFile(path.join(registryDir, "registry.json"), "{ corrupt json");
		await expectReadRegistryError(cwd, "invalid_manifest");
	});

	test("parallel registry updates keep all entries sorted and leave no tmp files", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-redteam-concurrent-registry-"));
		tempDirs.push(cwd);
		await fs.mkdir(path.join(cwd, ".gjc", "gjc-plugins"), { recursive: true });
		const names = ["zeta", "alpha", "omega", "beta", "gamma", "delta", "eta", "theta"];

		await Promise.all(
			names.map(name => updateRegistry("project", cwd, entries => [...entries, registryEntry(name, cwd)])),
		);

		const read = await readRegistry("project", cwd);
		expect(read.plugins.map(plugin => plugin.name)).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		const leftovers = (await fs.readdir(path.join(cwd, ".gjc", "gjc-plugins"))).filter(name =>
			name.includes(".tmp-"),
		);
		expect(leftovers).toEqual([]);
	});
});
