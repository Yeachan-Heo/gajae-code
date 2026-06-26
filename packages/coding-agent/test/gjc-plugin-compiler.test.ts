import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	compileGjcPluginBundle,
	GjcPluginLoadError,
	type GjcPluginLoadErrorCode,
} from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

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

describe("GJC plugin compiler", () => {
	test("compiles a valid six-surface bundle with extension ids and digests", async () => {
		const bundle = await compileGjcPluginBundle(sixSurface);
		expect(bundle.name).toBe("valid-six-surface-bundle");
		expect(bundle.manifestHash).toMatch(/^[0-9a-f]{64}$/);

		expect(bundle.surfaces.subskills[0]?.extensionId).toBe("subskill:ralplan:planner:design");
		expect(bundle.surfaces.tools[0]?.extensionId).toBe("tool:domain_note");
		expect(bundle.surfaces.hooks[0]?.extensionId).toBe("hook:tool_call:before:read:audit-read");
		expect(bundle.surfaces.mcps[0]?.extensionId).toBe("mcp:domain_docs");
		expect(bundle.surfaces.systemAppendices[0]?.extensionId).toBe(
			"system-appendix:valid-six-surface-bundle:domain-policy",
		);
		expect(bundle.surfaces.agentAppendices[0]?.extensionId).toBe(
			"agent-appendix:executor:valid-six-surface-bundle:domain-executor",
		);

		// Every declared file is hashed and the manifest is recorded.
		expect(bundle.files.some(f => f.relativePath === "gajae-plugin.json")).toBe(true);
		expect(bundle.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
	});

	test("never imports plugin tool/hook code during compile", async () => {
		const sentinel = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sentinel-")), "sentinel.txt");
		tempDirs.push(path.dirname(sentinel));
		const prev = process.env.GJC_TEST_IMPORT_SENTINEL;
		process.env.GJC_TEST_IMPORT_SENTINEL = sentinel;
		try {
			await compileGjcPluginBundle(sixSurface);
		} finally {
			if (prev === undefined) delete process.env.GJC_TEST_IMPORT_SENTINEL;
			else process.env.GJC_TEST_IMPORT_SENTINEL = prev;
		}
		await expect(fs.access(sentinel)).rejects.toThrow();
	});

	test("rejects a path that escapes the plugin root", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-escape-"));
		tempDirs.push(dir);
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "escape",
				version: "1.0.0",
				system_appendix: [{ name: "x", path: "../escape.md" }],
			}),
		);
		await expectCompileError(dir, "missing_file");
	});

	test("rejects a declared sha256 that does not match file content", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hash-"));
		tempDirs.push(dir);
		await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
		await fs.writeFile(path.join(dir, "prompts", "sa.md"), "policy content\n");
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "hash",
				version: "1.0.0",
				system_appendix: [{ name: "x", path: "prompts/sa.md", sha256: "deadbeef" }],
			}),
		);
		await expectCompileError(dir, "hash_mismatch");
	});

	test("rejects appendix with both path and content", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-appendix-"));
		tempDirs.push(dir);
		await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
		await fs.writeFile(path.join(dir, "prompts", "sa.md"), "policy\n");
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "appendix",
				version: "1.0.0",
				system_appendix: [{ name: "x", path: "prompts/sa.md", content: "inline" }],
			}),
		);
		await expectCompileError(dir, "invalid_appendix");
	});
});
