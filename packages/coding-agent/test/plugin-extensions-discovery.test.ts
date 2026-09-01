import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { discoverAndLoadExtensions } from "@gajae-code/coding-agent/extensibility/extensions/loader";
import { getAgentDir, getPluginsDir, setAgentDir, TempDir } from "@gajae-code/utils";

const currentPiCodingAgentPath = Bun.resolveSync("@gajae-code/coding-agent", import.meta.dir);
const currentPiExtensionsPath = Bun.resolveSync("@gajae-code/coding-agent/extensibility/extensions", import.meta.dir);

describe("plugin extension discovery", () => {
	let projectDir: TempDir;
	let tempXdgDataHome = "";
	let originalXdgDataHome: string | undefined;
	const originalAgentDir = getAgentDir();

	beforeEach(async () => {
		projectDir = TempDir.createSync("@pi-plugin-ext-");
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		tempXdgDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-data-"));
		fs.mkdirSync(path.join(tempXdgDataHome, "gjc"), { recursive: true });
		process.env.XDG_DATA_HOME = tempXdgDataHome;
		// Rebuild path caches after changing XDG env so plugin discovery resolves into the temp root.
		setAgentDir(originalAgentDir);

		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "@demo", "plugin");
		fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
		await Bun.write(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "gjc-plugins",
				private: true,
				dependencies: {
					"@demo/plugin": "1.0.0",
				},
			}),
		);
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "@demo/plugin",
				version: "1.0.0",
				gjc: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		await Bun.write(
			path.join(pluginDir, "dist", "extension.ts"),
			`
				export default function(pi) {
					pi.registerCommand("plugin-ext", { handler: async () => {} });
				}
			`,
		);
	});

	afterEach(() => {
		projectDir.removeSync();
		fs.rmSync(tempXdgDataHome, { recursive: true, force: true });
		if (originalXdgDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdgDataHome;
		}
		setAgentDir(originalAgentDir);
	});

	it("loads installed plugin extensions declared in package.json", async () => {
		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path.endsWith(path.join("dist", "extension.ts")));

		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("plugin-ext")).toBe(true);
	});

	it("loads plugin extensions only from the selected agent profile", async () => {
		const ambientAgentDir = path.join(projectDir.path(), "ambient-agent");
		const selectedAgentDir = path.join(projectDir.path(), "selected-agent");
		const ambientNativeExtensionPath = path.join(ambientAgentDir, "extensions", "ambient.ts");
		const selectedNativeExtensionPath = path.join(selectedAgentDir, "extensions", "selected.ts");
		const selectedPluginsDir = path.join(selectedAgentDir, "plugins");
		const selectedPluginDir = path.join(selectedPluginsDir, "node_modules", "@selected", "plugin");
		const selectedExtensionPath = path.join(selectedPluginDir, "dist", "extension.ts");
		const nativeExtension = (command: string) => `
			export default function(pi) {
				pi.registerCommand("${command}", { handler: async () => {} });
			}
		`;
		fs.mkdirSync(path.dirname(ambientNativeExtensionPath), { recursive: true });
		fs.mkdirSync(path.dirname(selectedNativeExtensionPath), { recursive: true });
		await Bun.write(ambientNativeExtensionPath, nativeExtension("ambient-profile-ext"));
		await Bun.write(selectedNativeExtensionPath, nativeExtension("selected-native-ext"));
		setAgentDir(ambientAgentDir);
		fs.mkdirSync(path.dirname(selectedExtensionPath), { recursive: true });
		await Bun.write(
			path.join(selectedPluginsDir, "package.json"),
			JSON.stringify({
				name: "gjc-plugins",
				private: true,
				dependencies: {
					"@selected/plugin": "1.0.0",
				},
			}),
		);
		await Bun.write(
			path.join(selectedPluginDir, "package.json"),
			JSON.stringify({
				name: "@selected/plugin",
				version: "1.0.0",
				gjc: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		await Bun.write(
			selectedExtensionPath,
			`
				export default function(pi) {
					pi.registerCommand("selected-profile-ext", { handler: async () => {} });
				}
			`,
		);

		const ambientExtensionPath = path.join(
			getPluginsDir(),
			"node_modules",
			"@demo",
			"plugin",
			"dist",
			"extension.ts",
		);
		const settings = Settings.isolated({}, { agentDir: selectedAgentDir });
		const result = await discoverAndLoadExtensions([], projectDir.path(), undefined, [], undefined, settings);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions.some(ext => ext.path === selectedExtensionPath)).toBe(true);
		expect(result.extensions.some(ext => ext.path === selectedNativeExtensionPath)).toBe(true);
		expect(result.extensions.some(ext => ext.path === ambientExtensionPath)).toBe(false);
		expect(result.extensions.some(ext => ext.path === ambientNativeExtensionPath)).toBe(false);
		expect(
			result.extensions.find(ext => ext.path === selectedExtensionPath)?.commands.has("selected-profile-ext"),
		).toBe(true);
	});

	it("loads installed legacy Pi plugin extensions from Windows drive-letter paths", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "legacy-pi-plugin");
		const extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.rmSync(path.join(pluginsDir, "node_modules"), { recursive: true, force: true });
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		await Bun.write(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "gjc-plugins",
				private: true,
				dependencies: {
					"legacy-pi-plugin": "1.0.0",
				},
			}),
		);
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "legacy-pi-plugin",
				version: "1.0.0",
				pi: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		await Bun.write(
			extensionPath,
			[
				'import * as nodePath from "path";',
				'if (false) import("./optional-missing.js");',
				'import { isToolCallEventType as legacyRoot } from "@mariozechner/gajae-code";',
				'import { isToolCallEventType as legacyExtensions } from "@mariozechner/gajae-code/extensibility/extensions";',
				`import { isToolCallEventType as modernRoot } from ${JSON.stringify(currentPiCodingAgentPath)};`,
				`import { isToolCallEventType as modernExtensions } from ${JSON.stringify(currentPiExtensionsPath)};`,
				"",
				'if (legacyRoot !== modernRoot) throw new Error("legacy root import did not remap");',
				'if (legacyExtensions !== modernExtensions) throw new Error("legacy extension import did not remap");',
				'if (typeof nodePath.join !== "function") throw new Error("node builtin import did not resolve");',
				"",
				"export default function(pi) {",
				"\tconst { Type } = pi.typebox;",
				"\tpi.registerTool({",
				'\t\tname: "legacy-pi-ext",',
				'\t\tdescription: "Legacy Pi extension smoke test",',
				"\t\tparameters: Type.Object({}),",
				'\t\texecute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
				"\t});",
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		if (process.platform === "win32") {
			expect(extensionPath).toMatch(/^[A-Za-z]:\\/);
		}
		expect(result.errors).toHaveLength(0);
		expect(extension).toBeDefined();
		expect(extension?.tools.has("legacy-pi-ext")).toBe(true);
	});

	it("loads installed plugin extensions whose manifest entry points at a directory with index.ts", async () => {
		const pluginsDir = getPluginsDir();
		const pluginDir = path.join(pluginsDir, "node_modules", "dir-entry-plugin");
		const extensionDir = path.join(pluginDir, ".pi", "extensions", "dir-entry");
		const extensionPath = path.join(extensionDir, "index.ts");
		fs.rmSync(path.join(pluginsDir, "node_modules"), { recursive: true, force: true });
		fs.mkdirSync(extensionDir, { recursive: true });
		await Bun.write(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({
				name: "gjc-plugins",
				private: true,
				dependencies: {
					"dir-entry-plugin": "1.0.0",
				},
			}),
		);
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "dir-entry-plugin",
				version: "1.0.0",
				pi: {
					// Directory entry — loader must resolve to the directory's index file.
					extensions: [".pi/extensions/dir-entry"],
				},
			}),
		);
		await Bun.write(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.registerCommand("dir-entry-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const result = await discoverAndLoadExtensions([], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		const pluginError = result.errors.find(err => err.path.includes(path.join("dir-entry-plugin", ".pi")));

		expect(pluginError).toBeUndefined();
		expect(extension).toBeDefined();
		expect(extension?.commands.has("dir-entry-ext")).toBe(true);
	});
});
