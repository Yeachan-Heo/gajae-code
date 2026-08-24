import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	compileGjcPluginBundle,
	GjcPluginLoadError,
	getGjcPluginMigrationStatuses,
	getGjcPluginToolDeclarations,
	loadAlwaysOnPluginTools,
	PluginImplementationHashMismatchError,
	readRegistry,
	serveGjcPluginSchemas,
} from "../src/extensibility/gjc-plugins";
import { writeRegistry } from "../src/extensibility/gjc-plugins/registry";
import type { GjcPluginRegistryEntry } from "../src/extensibility/gjc-plugins/types";

const fixture = path.join(import.meta.dir, "fixtures", "gjc-plugins", "valid-six-surface-bundle");
const originalAgentDir = getAgentDir();
const tempRoots: string[] = [];
let agentDir: string;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function makeCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-registry-v2-"));
	tempRoots.push(cwd);
	return cwd;
}

async function writeLegacyEntry(cwd: string, root: string): Promise<void> {
	const bundle = await compileGjcPluginBundle(root);
	const surfaces = structuredClone(bundle.surfaces);
	for (const tool of surfaces.tools) {
		delete tool.schema;
		delete tool.schemaHash;
		delete tool.implementationHash;
		delete tool.metadataVersion;
	}
	for (const hook of surfaces.hooks) delete hook.implementationHash;
	const entry: GjcPluginRegistryEntry = {
		name: bundle.name,
		version: bundle.version,
		scope: "project",
		enabled: true,
		pluginRoot: root,
		manifestPath: bundle.manifestPath,
		manifestHash: bundle.manifestHash,
		source: { kind: "path", uri: root, resolvedAt: new Date().toISOString() },
		installedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		copiedFiles: bundle.files,
		surfaces,
		disabledSurfaceIds: [],
	};
	await writeRegistry({ version: 1, scope: "project", plugins: [entry] }, cwd);
}

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-registry-v2-agent-"));
	tempRoots.push(agentDir);
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("GJC plugin registry v2 cutover", () => {
	test("auto-migrates a v1 entry before activation without importing implementation code", async () => {
		const cwd = await makeCwd();
		const root = path.join(cwd, "plugin");
		await fs.cp(fixture, root, { recursive: true });
		await writeLegacyEntry(cwd, root);
		const sentinel = path.join(cwd, "imported");
		process.env.GJC_TEST_IMPORT_SENTINEL = sentinel;
		try {
			const registry = await readRegistry("project", cwd);
			const tool = registry.plugins[0]?.surfaces.tools[0];
			expect(registry.plugins[0]?.migration?.status).toBe("migrated");
			expect(tool).toMatchObject({
				metadataVersion: 2,
				schemaHash: expect.any(String),
				implementationHash: expect.any(String),
			});
			expect(
				await fs
					.stat(sentinel)
					.then(() => true)
					.catch(() => false),
			).toBe(false);
		} finally {
			delete process.env.GJC_TEST_IMPORT_SENTINEL;
		}
	});

	test("migration failure quarantines the plugin and reports plugin/surface/cause", async () => {
		const cwd = await makeCwd();
		const root = path.join(cwd, "plugin");
		await fs.cp(fixture, root, { recursive: true });
		const manifestPath = path.join(root, "gajae-plugin.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
		const tools = manifest.tools as Array<Record<string, unknown>>;
		tools[0]!.schema = { type: "not-a-json-schema-type" };
		const manifestText = JSON.stringify(manifest);
		await fs.writeFile(manifestPath, manifestText);
		const bundle = await compileGjcPluginBundle(fixture);
		for (const tool of bundle.surfaces.tools) {
			delete tool.schema;
			delete tool.schemaHash;
			delete tool.implementationHash;
			delete tool.metadataVersion;
		}
		for (const hook of bundle.surfaces.hooks) delete hook.implementationHash;
		const implementation = await fs.readFile(path.join(root, "tools/domain-note.ts"), "utf8");
		const entry: GjcPluginRegistryEntry = {
			name: "valid-six-surface-bundle",
			version: "1.0.0",
			scope: "project",
			enabled: true,
			pluginRoot: root,
			manifestPath,
			manifestHash: sha256(manifestText),
			source: { kind: "path", uri: root, resolvedAt: new Date().toISOString() },
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			copiedFiles: [
				{ relativePath: "gajae-plugin.json", sha256: sha256(manifestText), bytes: Buffer.byteLength(manifestText) },
				{
					relativePath: "tools/domain-note.ts",
					sha256: sha256(implementation),
					bytes: Buffer.byteLength(implementation),
				},
			],
			surfaces: bundle.surfaces,
			disabledSurfaceIds: [],
		};
		await writeRegistry({ version: 1, scope: "project", plugins: [entry] }, cwd);
		const loaded = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(loaded.tools).toHaveLength(0);
		expect(loaded.quarantine[0]).toMatchObject({
			plugin: "valid-six-surface-bundle",
			surfaceId: expect.stringContaining("tool:"),
			code: "migration_required",
		});
		const status = (await getGjcPluginMigrationStatuses(cwd))[0];
		expect(status).toMatchObject({
			plugin: "valid-six-surface-bundle",
			status: "failed",
			failure: { surface: expect.stringContaining("tool:"), cause: expect.any(String) },
		});
	});

	test("serves canonical schemas without importing implementations", async () => {
		const cwd = await makeCwd();
		const root = path.join(cwd, "plugin");
		await fs.cp(fixture, root, { recursive: true });
		await writeLegacyEntry(cwd, root);
		const sentinel = path.join(cwd, "imported");
		process.env.GJC_TEST_IMPORT_SENTINEL = sentinel;
		try {
			const schemas = await serveGjcPluginSchemas(cwd);
			expect(schemas["tool:domain_note"]).toMatchObject({ $schema: "https://json-schema.org/draft/2020-12/schema" });
			expect(
				await fs
					.stat(sentinel)
					.then(() => true)
					.catch(() => false),
			).toBe(false);
		} finally {
			delete process.env.GJC_TEST_IMPORT_SENTINEL;
		}
	});
	test("resolves the user-scope registry from the session agent directory", async () => {
		const cwd = await makeCwd();
		const root = path.join(cwd, "plugin");
		await fs.cp(fixture, root, { recursive: true });
		const bundle = await compileGjcPluginBundle(root);
		const sessionAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-registry-v2-session-agent-"));
		tempRoots.push(sessionAgentDir);
		const entry: GjcPluginRegistryEntry = {
			name: bundle.name,
			version: bundle.version,
			scope: "user",
			enabled: true,
			pluginRoot: root,
			manifestPath: bundle.manifestPath,
			manifestHash: bundle.manifestHash,
			source: { kind: "path", uri: root, resolvedAt: new Date().toISOString() },
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			copiedFiles: bundle.files,
			surfaces: bundle.surfaces,
			disabledSurfaceIds: [],
		};
		await writeRegistry({ version: 1, scope: "user", plugins: [entry] }, cwd, "user", sessionAgentDir);

		const sessionScoped = await readRegistry("user", cwd, { agentDir: sessionAgentDir, migrate: false });
		expect(sessionScoped.plugins[0]?.name).toBe(bundle.name);
		const processScoped = await readRegistry("user", cwd, { migrate: false });
		expect(processScoped.plugins).toHaveLength(0);
		const declarations = await getGjcPluginToolDeclarations(cwd, sessionAgentDir);
		expect(declarations[0]?.plugin).toBe(bundle.name);
		const processDeclarations = await getGjcPluginToolDeclarations(cwd);
		expect(processDeclarations).toHaveLength(0);
	});

	test("implementation hash mismatch refuses the single v2 import path", async () => {
		const cwd = await makeCwd();
		const root = path.join(cwd, "plugin");
		await fs.cp(fixture, root, { recursive: true });
		await writeLegacyEntry(cwd, root);
		await readRegistry("project", cwd);
		const registryPath = path.join(cwd, ".gjc", "gjc-plugins", "registry.json");
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
			plugins: Array<{ surfaces: { tools: Array<Record<string, unknown>> } }>;
		};
		registry.plugins[0]!.surfaces.tools[0]!.implementationHash = "0".repeat(64);
		await fs.writeFile(registryPath, JSON.stringify(registry));
		const sentinel = path.join(cwd, "imported");
		process.env.GJC_TEST_IMPORT_SENTINEL = sentinel;
		try {
			const loaded = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
			expect(loaded.tools).toHaveLength(0);
			expect(loaded.quarantine[0]?.code).toBe("runtime_mismatch");
			expect(
				await fs
					.stat(sentinel)
					.then(() => true)
					.catch(() => false),
			).toBe(false);
		} finally {
			delete process.env.GJC_TEST_IMPORT_SENTINEL;
		}
		await expect(
			Promise.reject(new PluginImplementationHashMismatchError("tool.ts", "a", "b")),
		).rejects.toBeInstanceOf(GjcPluginLoadError);
	});
});
