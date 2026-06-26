import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installGjcPluginBundle, loadConstrainedPluginHooks } from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];

afterEach(async () => {
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function mkCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hooks-"));
	tempDirs.push(cwd);
	return cwd;
}

async function bundleWithHook(hookBody: string): Promise<string> {
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
			hooks: [{ name: "h", event: "tool_call", target: "read", phase: "before", path: "hooks/h.ts" }],
		}),
	);
	return src;
}

describe("constrained plugin hooks", () => {
	test("loads a declared hook that registers its event via the constrained api", async () => {
		const cwd = await mkCwd();
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
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
		await installGjcPluginBundle(src, { scope: "project", cwd });
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.hooks).toHaveLength(0);
		expect(res.quarantine.some(q => q.code === "security_policy")).toBe(true);
	});

	test("quarantines a hook that calls denied sendMessage", async () => {
		const cwd = await mkCwd();
		const src = await bundleWithHook(
			"export default function(api){ api.sendMessage({}); api.on('tool_call', ()=>({})); }\n",
		);
		await installGjcPluginBundle(src, { scope: "project", cwd });
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.quarantine.some(q => q.code === "security_policy")).toBe(true);
	});

	test("quarantines runtime_mismatch when the hook registers a different event", async () => {
		const cwd = await mkCwd();
		const src = await bundleWithHook("export default function(api){ api.on('turn_start', ()=>({})); }\n");
		await installGjcPluginBundle(src, { scope: "project", cwd });
		const res = await loadConstrainedPluginHooks({ cwd });
		expect(res.hooks).toHaveLength(0);
		expect(res.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
	});
});
