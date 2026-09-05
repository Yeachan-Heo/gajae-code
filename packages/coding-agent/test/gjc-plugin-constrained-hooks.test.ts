import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	ConstrainedPluginHookDescriptor,
	installGjcBundle,
	loadConstrainedPluginHooks,
	registryPathForScope,
} from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];
const originalAgentDir = getAgentDir();
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hooks-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

async function mkCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hooks-"));
	tempDirs.push(cwd);
	return cwd;
}

async function bundleWithHook(hookBody: string, hookOptions: Record<string, unknown> = {}): Promise<string> {
	const src = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hooksrc-"));
	tempDirs.push(src);
	await fs.mkdir(path.join(src, "hooks"), { recursive: true });
	await fs.writeFile(path.join(src, "hooks", "h.ts"), hookBody);
	await fs.writeFile(
		path.join(src, "gajae-plugin.json"),
		JSON.stringify({
			kind: "gajae-code-plugin",
			name: "hook-bundle",
			version: "1.0.0",
			hooks: [
				{
					name: "h",
					event: "tool_call",
					target: "read",
					phase: "before",
					path: "hooks/h.ts",
					...hookOptions,
				},
			],
		}),
	);
	return src;
}

async function expectTamperedFunctionHookQuarantined(
	hookOptions: Record<string, unknown>,
	mutate: (hook: Record<string, unknown>) => void,
): Promise<void> {
	const cwd = await mkCwd();
	const markerPath = path.join(cwd, "imported");
	const src = await bundleWithHook(
		`await Bun.write(${JSON.stringify(markerPath)}, "imported"); export default function(api){ api.on("tool_call", ()=>({})); }\n`,
		hookOptions,
	);
	await installGjcBundle({ cwd }, "project", src);
	const registryPath = registryPathForScope("project", cwd);
	const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
		plugins: Array<{ surfaces: { hooks: Array<Record<string, unknown>> } }>;
	};
	const hook = registry.plugins[0]?.surfaces.hooks[0];
	if (!hook) throw new Error("expected installed hook metadata");
	mutate(hook);
	await fs.writeFile(registryPath, JSON.stringify(registry));

	const res = await loadConstrainedPluginHooks({ cwd });
	expect(res.hooks).toHaveLength(0);
	expect(res.quarantine.some(q => q.code === "security_policy")).toBe(true);
	expect(await Bun.file(markerPath).exists()).toBe(false);
}

describe("constrained plugin hooks", () => {
	test("loads a declared hook that registers its event via the constrained api", async () => {
		const cwd = await mkCwd();
		await installGjcBundle({ cwd }, "project", sixSurface);
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.hooks.map(h => h.event)).toContain("tool_call");
		expect(res.quarantine).toHaveLength(0);
	});

	test("returns nothing when no plugins installed", async () => {
		const cwd = await mkCwd();
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.hooks).toHaveLength(0);
	});

	test("quarantines a hook that calls a denied API (registerCommand)", async () => {
		const cwd = await mkCwd();
		const src = await bundleWithHook(
			"export default function(api){ api.registerCommand('evil', { handler(){} }); api.on('tool_call', ()=>({})); }\n",
		);
		await installGjcBundle({ cwd }, "project", src);
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.hooks).toHaveLength(0);
		expect(res.quarantine.some(q => q.code === "security_policy")).toBe(true);
	});

	test("quarantines a hook that calls denied sendMessage", async () => {
		const cwd = await mkCwd();
		const src = await bundleWithHook(
			"export default function(api){ api.sendMessage({}); api.on('tool_call', ()=>({})); }\n",
		);
		await installGjcBundle({ cwd }, "project", src);
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.quarantine.some(q => q.code === "security_policy")).toBe(true);
	});

	test("quarantines runtime_mismatch when the hook registers a different event", async () => {
		const cwd = await mkCwd();
		const src = await bundleWithHook("export default function(api){ api.on('turn_start', ()=>({})); }\n");
		await installGjcBundle({ cwd }, "project", src);
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.hooks).toHaveLength(0);
		expect(res.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
	});

	test("rejects malformed declared metadata before hashing or importing plugin code", async () => {
		const root = await mkCwd();
		const hookPath = path.join(root, "malformed.ts");
		const markerPath = path.join(root, "imported");
		await fs.writeFile(
			hookPath,
			`await Bun.write(${JSON.stringify(markerPath)}, "imported"); export default () => undefined;\n`,
		);
		const descriptor = new ConstrainedPluginHookDescriptor({
			plugin: "malformed",
			scope: "project",
			event: "tool_call",
			target: "read",
			phase: "during" as never,
			relativePath: hookPath,
			implementationHash: "not-a-real-hash",
		});

		await expect(descriptor.load()).rejects.toThrow("invalid_plugin_phase");
		expect(await Bun.file(markerPath).exists()).toBe(false);
	});

	test("quarantines malformed registry metadata before evaluating an installed hook", async () => {
		const cwd = await mkCwd();
		const markerPath = path.join(cwd, "imported");
		const src = await bundleWithHook(
			`await Bun.write(${JSON.stringify(markerPath)}, "imported"); export default function(api){ api.on('tool_call', ()=>({})); }\n`,
		);
		await installGjcBundle({ cwd }, "project", src);
		const registryPath = registryPathForScope("project", cwd);
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
			plugins: Array<{ surfaces: { hooks: Array<{ phase?: string }> } }>;
		};
		const hook = registry.plugins[0]?.surfaces.hooks[0];
		if (!hook) throw new Error("expected installed hook metadata");
		hook.phase = "during";
		await fs.writeFile(registryPath, JSON.stringify(registry));

		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.hooks).toHaveLength(0);
		expect(res.quarantine.some(q => q.code === "invalid_hook")).toBe(true);
		expect(await Bun.file(markerPath).exists()).toBe(false);
	});

	test("quarantines plugin function hooks before importing them into the host realm", async () => {
		const cwd = await mkCwd();
		const markerPath = path.join(cwd, "imported");
		const src = await bundleWithHook(
			`await Bun.write(${JSON.stringify(markerPath)}, "imported"); export default function(api){ api.on("tool_call", ()=>({})); }\n`,
			{ capabilities: ["tool.inspect"] },
		);
		await installGjcBundle({ cwd }, "project", src);
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.hooks).toHaveLength(0);
		expect(res.quarantine.some(q => q.code === "security_policy")).toBe(true);
		expect(await Bun.file(markerPath).exists()).toBe(false);
	});

	test("quarantines a function hook when persisted functionHook metadata is flipped off", async () => {
		await expectTamperedFunctionHookQuarantined({ capabilities: ["tool.inspect"] }, hook => {
			hook.functionHook = false;
		});
	});

	test("quarantines a function hook when persisted grant metadata or its hash is tampered", async () => {
		await expectTamperedFunctionHookQuarantined({ capabilities: ["tool.inspect"] }, hook => {
			hook.capabilities = ["tool.transform"];
		});
		await expectTamperedFunctionHookQuarantined(
			{ capabilities: ["network.fetch"], networkDestinations: ["https://example.com"] },
			hook => {
				hook.networkDestinations = ["https://evil.example"];
			},
		);
		await expectTamperedFunctionHookQuarantined(
			{ capabilities: ["filesystem.read"], filesystemRoots: ["/tmp"] },
			hook => {
				hook.filesystemRoots = ["/etc"];
			},
		);
		await expectTamperedFunctionHookQuarantined({ capabilities: ["tool.inspect"] }, hook => {
			hook.capabilityHash = "0".repeat(64);
		});
	});

	test("quarantines a function hook when persisted identity or implementation metadata is tampered", async () => {
		for (const mutate of [
			(hook: Record<string, unknown>) => {
				hook.extensionId = "hook:tool_call:before:write:h";
			},
			(hook: Record<string, unknown>) => {
				hook.target = "write";
			},
			(hook: Record<string, unknown>) => {
				hook.relativePath = "hooks/other.ts";
			},
			(hook: Record<string, unknown>) => {
				hook.implementationHash = "0".repeat(64);
			},
		]) {
			await expectTamperedFunctionHookQuarantined({ capabilities: ["tool.inspect"] }, mutate);
		}
	});
});
