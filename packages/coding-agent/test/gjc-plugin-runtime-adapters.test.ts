import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installGjcPluginBundle, loadAlwaysOnPluginTools } from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];

afterEach(async () => {
	for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function mkCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-rt-"));
	tempDirs.push(cwd);
	return cwd;
}

describe("always-on plugin tool runtime activation", () => {
	test("loads a declared always-on tool from an installed bundle", async () => {
		const cwd = await mkCwd();
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
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
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: ["domain_note"] });
		expect(res.tools.map(t => t.name)).not.toContain("domain_note");
		expect(res.quarantine.some(q => q.code === "session_collision")).toBe(true);
	});

	test("quarantines on installed-file hash drift", async () => {
		const cwd = await mkCwd();
		await installGjcPluginBundle(sixSurface, { scope: "project", cwd });
		const installed = path.join(cwd, ".gjc", "gjc-plugins", "valid-six-surface-bundle", "tools", "domain-note.ts");
		await fs.appendFile(installed, "\n// tampered after install\n");
		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(res.tools.map(t => t.name)).not.toContain("domain_note");
		expect(res.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
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
		await installGjcPluginBundle(src, { scope: "project", cwd });
		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(res.tools.map(t => t.name)).not.toContain("actual_y");
		expect(res.tools.map(t => t.name)).not.toContain("declared_x");
		expect(res.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
	});
});
