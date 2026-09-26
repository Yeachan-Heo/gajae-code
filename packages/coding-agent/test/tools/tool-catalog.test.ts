import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateToolCatalogData, ToolCatalogGenerationError } from "../../scripts/generate-tool-catalog";
import { clearPluginRootsAndCaches } from "../../src/discovery/helpers";
import { discoverAgents } from "../../src/task/discovery";
import { TOOL_CATALOG } from "../../src/tools/tool-catalog.generated";

describe("generated tool catalog", () => {
	test("committed advertised metadata is reproducible from eager implementations", async () => {
		const regenerated = await generateToolCatalogData();
		expect(regenerated).toEqual(TOOL_CATALOG);
	});
	test("advertised descriptions contain no unrendered or undefined template values", () => {
		// TOOL_CATALOG is exported, and deferred (discoverable) tools advertise its description
		// until they materialize, so a template variable missing from the generator's
		// settings must not render as "undefined" or a raw {{PLACEHOLDER}}.
		for (const [name, entry] of Object.entries(TOOL_CATALOG)) {
			const description = entry.description ?? "";
			expect({ name, match: description.match(/\b(?:undefined|NaN)\b|\{\{[^}]*\}\}/)?.[0] }).toEqual({
				name,
				match: undefined,
			});
		}
	});
	test("move_session is generated with essential loadMode and exclusive non-abortable metadata", () => {
		expect(TOOL_CATALOG.move_session?.loadMode).toBe("essential");
		expect(TOOL_CATALOG.move_session?.deferrable).toBe(false);
		expect(TOOL_CATALOG.move_session?.nonAbortable).toBe(true);
		expect(TOOL_CATALOG.move_session?.concurrency).toBe("exclusive");
	});

	test("ambient agent fixtures cannot contaminate generated task metadata", async () => {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tool-catalog-project-"));
		const pluginRoot = path.join(project, "review-plugin");
		const registryPath = path.join(project, ".gjc", "plugins", "installed_plugins.json");
		try {
			const agentsDir = path.join(pluginRoot, "agents");
			await fs.mkdir(agentsDir, { recursive: true });
			await fs.copyFile(
				path.join(
					import.meta.dir,
					"..",
					"marketplace",
					"fixtures",
					"valid-marketplace",
					"plugins",
					"hello-plugin",
					"agents",
					"reviewer.md",
				),
				path.join(agentsDir, "reviewer.md"),
			);
			await fs.mkdir(path.dirname(registryPath), { recursive: true });
			await Bun.write(
				registryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"review-plugin@test-marketplace": [
							{
								scope: "user",
								installPath: pluginRoot,
								version: "1.0.0",
								installedAt: "2026-08-13T00:00:00.000Z",
								lastUpdated: "2026-08-13T00:00:00.000Z",
							},
						],
					},
				}),
			);
			clearPluginRootsAndCaches([registryPath]);
			const predecessor = await discoverAgents(project);
			expect(predecessor.agents.map(agent => agent.name)).toContain("reviewer");

			const regenerated = await generateToolCatalogData({ cwd: project });
			expect(regenerated.task?.description).not.toContain("# reviewer");
			expect(regenerated).toEqual(TOOL_CATALOG);
		} finally {
			clearPluginRootsAndCaches([registryPath]);
			await fs.rm(project, { recursive: true, force: true });
		}
	});

	test("unavailable fallback rejects corrupted committed metadata and schema", async () => {
		const recipeEntry = TOOL_CATALOG.recipe;
		if (!recipeEntry) throw new Error("recipe catalog entry missing");
		const recipeParameters = recipeEntry.parameters;
		if (!recipeParameters || typeof recipeParameters !== "object") throw new Error("recipe schema metadata missing");
		const properties = (recipeParameters as Record<string, unknown>).properties;
		if (!properties || typeof properties !== "object") throw new Error("recipe properties metadata missing");
		const op = (properties as Record<string, unknown>).op;
		if (!op || typeof op !== "object") throw new Error("recipe op metadata missing");
		const metadataMutations: Array<[key: "label" | "summary" | "strict" | "description", value: unknown]> = [
			["label", "Corrupted label"],
			["summary", "Corrupted summary"],
			["strict", !recipeEntry.strict],
			["description", "Corrupted description"],
		];
		for (const [key, value] of metadataMutations) {
			const original = recipeEntry[key];
			(recipeEntry as unknown as Record<string, unknown>)[key] = value;
			try {
				await expect(generateToolCatalogData()).rejects.toBeInstanceOf(ToolCatalogGenerationError);
			} finally {
				(recipeEntry as unknown as Record<string, unknown>)[key] = original;
			}
		}
		const originalType = (op as Record<string, unknown>).type;
		(op as Record<string, unknown>).type = "number";
		try {
			await expect(generateToolCatalogData()).rejects.toBeInstanceOf(ToolCatalogGenerationError);
		} finally {
			(op as Record<string, unknown>).type = originalType;
		}
	});
	test("platform-excluded computer catalog remains reproducible under simulated Windows", async () => {
		const windowsCatalog = await generateToolCatalogData({ platform: "win32", arch: "x64" });
		expect(windowsCatalog.computer).toEqual(TOOL_CATALOG.computer);
	});
});
