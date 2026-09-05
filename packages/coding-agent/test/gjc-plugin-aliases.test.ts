/**
 * Issue #4287 acceptance tests: plugin loose-surface separation.
 *
 * Acceptance 1: canonical GJC vocabulary and accepted compatibility aliases
 *               compile to byte-equivalent normalized surfaces.
 * Acceptance 2: ambiguous/unsafe aliases fail with an actionable suggested
 *               canonical form (targeted migration diagnostic).
 * Acceptance 4: install, force update, disable, quarantine, uninstall, and
 *               hash-drift behavior remain covered when a bundle uses the
 *               alias vocabulary.
 * Acceptance 5: no compatibility alias bypasses collision, trust, MCP
 *               security, constrained-hook, or appendix authority rules.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	applyGjcBundleUpdate,
	assertMcpInstallPolicy,
	buildPluginMcpConfigs,
	compileGjcPluginBundle,
	GjcPluginLoadError,
	type GjcPluginMcpManifestEntry,
	type GjcPluginRegistryEntry,
	installGjcBundle,
	type NormalizedGjcPluginBundle,
	parseManifest,
	previewGjcBundleUpdate,
	readRegistry,
	setGjcBundleSurfaceEnabled,
	uninstallGjcBundle,
	validateInstallPlan,
	verifyEntryHashes,
} from "../src/extensibility/gjc-plugins";

const tempDirs: string[] = [];
const originalAgentDir = getAgentDir();
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-alias-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

async function mkTemp(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function writeManifestBundle(root: string, manifest: Record<string, unknown>): Promise<string> {
	await fs.writeFile(path.join(root, "gajae-plugin.json"), JSON.stringify(manifest, null, 2));
	return root;
}

function expectAliasError(
	fn: () => unknown,
	code: GjcPluginLoadError["code"],
	messageMustContain: readonly string[],
): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(GjcPluginLoadError);
		const err = error as GjcPluginLoadError;
		expect(err.code).toBe(code);
		for (const needle of messageMustContain) {
			expect(err.message).toContain(needle);
		}
		return;
	}
	throw new Error(`Expected ${code} load error`);
}

const canonicalManifest = {
	kind: "gajae-code-plugin",
	name: "alias-equivalence",
	version: "1.0.0",
	mcps: [
		{ name: "docs", transport: "stdio", command: "bun", args: ["mcp/server.ts"], cwd: "." },
		{ name: "remote", transport: "http", url: "https://example.com/mcp" },
	],
};

const aliasManifest = {
	kind: "gajae-code-plugin",
	name: "alias-equivalence",
	version: "1.0.0",
	mcpServers: {
		docs: { type: "stdio", command: "bun", args: ["mcp/server.ts"], cwd: "." },
		remote: { url: "https://example.com/mcp" },
	},
};

describe("issue #4287 acceptance 1: aliases compile to byte-equivalent normalized surfaces", () => {
	test("canonical mcps and mcpServers alias parse to identical manifest entries", () => {
		const canonical = parseManifest(canonicalManifest, "/plugin/canonical/gajae-plugin.json");
		const aliased = parseManifest(aliasManifest, "/plugin/aliased/gajae-plugin.json");
		expect(aliased.mcps).toEqual(canonical.mcps);
		expect(JSON.stringify(aliased.mcps)).toBe(JSON.stringify(canonical.mcps));
	});

	test("canonical mcps and mcpServers alias compile to byte-equivalent surfaces", async () => {
		const canonicalRoot = await mkTemp("gjc-alias-canonical-");
		const aliasRoot = await mkTemp("gjc-alias-alias-");
		await writeManifestBundle(canonicalRoot, canonicalManifest);
		await writeManifestBundle(aliasRoot, aliasManifest);
		for (const root of [canonicalRoot, aliasRoot]) {
			await fs.mkdir(path.join(root, "mcp"), { recursive: true });
			await fs.writeFile(path.join(root, "mcp", "server.ts"), "export default {};\n");
		}

		const [canonical, aliased] = await Promise.all([
			compileGjcPluginBundle(canonicalRoot),
			compileGjcPluginBundle(aliasRoot),
		]);
		expect(aliased.surfaces).toEqual(canonical.surfaces);
		// The normalized surfaces are byte-equivalent, not merely structurally
		// equal: canonical serialization must match byte for byte.
		expect(JSON.stringify(aliased.surfaces)).toBe(JSON.stringify(canonical.surfaces));
		expect(aliased.surfaces.mcps.map(s => s.configHash)).toEqual(canonical.surfaces.mcps.map(s => s.configHash));
	});

	test("transport inference is deterministic: command -> stdio, url -> http, explicit type wins", () => {
		const manifest = parseManifest(
			{
				kind: "gajae-code-plugin",
				name: "infer",
				version: "1.0.0",
				mcpServers: {
					a: { command: "bun", args: ["s.ts"] },
					b: { url: "https://example.com/mcp" },
					c: { type: "sse", url: "https://example.com/sse" },
				},
			},
			"/plugin/infer/gajae-plugin.json",
		);
		expect(manifest.mcps.map(m => [m.name, m.transport])).toEqual([
			["a", "stdio"],
			["b", "http"],
			["c", "sse"],
		]);
	});

	test("map insertion order does not change normalized surfaces or config hashes", async () => {
		const firstRoot = await mkTemp("gjc-alias-order-a-");
		const secondRoot = await mkTemp("gjc-alias-order-b-");
		await writeManifestBundle(firstRoot, {
			kind: "gajae-code-plugin",
			name: "ordered",
			version: "1.0.0",
			mcpServers: {
				zeta: { url: "https://example.com/z" },
				alpha: { url: "https://example.com/a" },
			},
		});
		await writeManifestBundle(secondRoot, {
			kind: "gajae-code-plugin",
			name: "ordered",
			version: "1.0.0",
			mcpServers: {
				alpha: { url: "https://example.com/a" },
				zeta: { url: "https://example.com/z" },
			},
		});

		const [first, second] = await Promise.all([
			compileGjcPluginBundle(firstRoot),
			compileGjcPluginBundle(secondRoot),
		]);
		expect(first.manifestHash).not.toBe(second.manifestHash);
		expect(first.surfaces).toEqual(second.surfaces);
		expect(JSON.stringify(first.surfaces)).toBe(JSON.stringify(second.surfaces));
		expect(first.surfaces.mcps.map(m => m.configHash)).toEqual(second.surfaces.mcps.map(m => m.configHash));
	});

	test("alias determinism does not rewrite the established canonical config hash", async () => {
		const root = await mkTemp("gjc-canonical-hash-compat-");
		await writeManifestBundle(root, {
			kind: "gajae-code-plugin",
			name: "canonical-hash-compat",
			version: "1.0.0",
			mcps: [
				{
					name: "remote",
					transport: "http",
					url: "https://example.com/mcp",
					headers: { z: "2", a: "1" },
				},
			],
		});
		const bundle = await compileGjcPluginBundle(root);
		expect(bundle.surfaces.mcps[0]?.configHash).toBe(
			"39585360e397aa5dd3b1b18595d01f23c52d6ba90f1f30720e8680fa0bd50c9c",
		);
	});

	test("prototype-like server names remain ordinary deterministic entries", () => {
		const manifest = parseManifest(
			{
				kind: "gajae-code-plugin",
				name: "prototype-names",
				version: "1.0.0",
				mcpServers: {
					toString: { url: "https://example.com/to-string" },
					constructor: { url: "https://example.com/constructor" },
					prototype: { url: "https://example.com/prototype" },
				},
			},
			"/plugin/prototype-names/gajae-plugin.json",
		);
		expect(manifest.mcps.map(m => m.name)).toEqual(["constructor", "prototype", "toString"]);
	});
});

describe("issue #4287 acceptance 2: ambiguous/unsafe aliases fail with actionable canonical form", () => {
	test("singular mcp alias names both canonical alternatives", () => {
		expectAliasError(
			() =>
				parseManifest(
					{ kind: "gajae-code-plugin", name: "x", version: "1.0.0", mcp: [] },
					"/plugin/x/gajae-plugin.json",
				),
			"unsupported_surface",
			['"mcp"', '"mcps"', '"mcpServers"'],
		);
	});

	test("mcpServers env cannot be preserved and points at the loose mcp surface", () => {
		expectAliasError(
			() =>
				parseManifest(
					{
						kind: "gajae-code-plugin",
						name: "x",
						version: "1.0.0",
						mcpServers: { db: { command: "bun", args: ["s.ts"], env: { TOKEN: "t" } } },
					},
					"/plugin/x/gajae-plugin.json",
				),
			"unsupported_surface",
			['mcpServers["db"]', '"env"', "mcp.json"],
		);
	});

	test("mcpServers auth/oauth/headers/enablement controls cannot be preserved", () => {
		for (const key of ["auth", "oauth", "headers", "enabled", "timeout", "autoload", "noInheritEnv"]) {
			expectAliasError(
				() =>
					parseManifest(
						{
							kind: "gajae-code-plugin",
							name: "x",
							version: "1.0.0",
							mcpServers: { db: { command: "bun", args: ["s.ts"], [key]: true } },
						},
						"/plugin/x/gajae-plugin.json",
					),
				"unsupported_surface",
				[`"${key}"`, ".gjc/mcp.json"],
			);
		}
	});

	test("mcpServers rejects fields incompatible with the selected transport", () => {
		for (const entry of [
			{ type: "stdio", command: "bun", args: ["s.ts"], url: "https://example.com/mcp" },
			{ type: "http", url: "https://example.com/mcp", command: "bun" },
			{ type: "sse", url: "https://example.com/sse", cwd: "." },
		]) {
			expectAliasError(
				() =>
					parseManifest(
						{ kind: "gajae-code-plugin", name: "x", version: "1.0.0", mcpServers: { db: entry } },
						"/plugin/x/gajae-plugin.json",
					),
				"unsupported_surface",
				["cannot preserve", ".gjc/mcp.json"],
			);
		}
	});

	test("mcpServers unknown keys name the supported canonical vocabulary", () => {
		expectAliasError(
			() =>
				parseManifest(
					{
						kind: "gajae-code-plugin",
						name: "x",
						version: "1.0.0",
						mcpServers: { db: { command: "bun", args: ["s.ts"], transport: "stdio" } },
					},
					"/plugin/x/gajae-plugin.json",
				),
			"unsupported_surface",
			['mcpServers["db"]', '"transport"', '"type"'],
		);
	});

	test("mcpServers entry with both command and url without type is ambiguous", () => {
		expectAliasError(
			() =>
				parseManifest(
					{
						kind: "gajae-code-plugin",
						name: "x",
						version: "1.0.0",
						mcpServers: { db: { command: "bun", args: ["s.ts"], url: "https://example.com/mcp" } },
					},
					"/plugin/x/gajae-plugin.json",
				),
			"invalid_manifest",
			['mcpServers["db"]', '"command"', '"url"', '"type"'],
		);
	});

	test("top-level skills declaration names the loose skill surface and subskills", () => {
		expectAliasError(
			() =>
				parseManifest(
					{ kind: "gajae-code-plugin", name: "x", version: "1.0.0", skills: ["SKILL.md"] },
					"/plugin/x/gajae-plugin.json",
				),
			"forbidden_surface",
			['"skills"', '"subskills"', ".gjc/skills/"],
		);
	});

	test("Claude Code agents/commands/slash-commands keys name their safe alternative", () => {
		expectAliasError(
			() =>
				parseManifest(
					{ kind: "gajae-code-plugin", name: "x", version: "1.0.0", agents: [{ name: "a" }] },
					"/plugin/x/gajae-plugin.json",
				),
			"forbidden_surface",
			['"agents"', '"subskills"', "executor"],
		);
		expectAliasError(
			() =>
				parseManifest(
					{ kind: "gajae-code-plugin", name: "x", version: "1.0.0", commands: [{ name: "c" }] },
					"/plugin/x/gajae-plugin.json",
				),
			"forbidden_surface",
			['"commands"', ".gjc/commands/"],
		);
		expectAliasError(
			() =>
				parseManifest(
					{ kind: "gajae-code-plugin", name: "x", version: "1.0.0", "slash-commands": [] },
					"/plugin/x/gajae-plugin.json",
				),
			"forbidden_surface",
			['"slash-commands"', ".gjc/commands/"],
		);
	});

	test("Claude Code hooks map shape names the canonical hook entry and loose surface", () => {
		expectAliasError(
			() =>
				parseManifest(
					{
						kind: "gajae-code-plugin",
						name: "x",
						version: "1.0.0",
						hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }] }] },
					},
					"/plugin/x/gajae-plugin.json",
				),
			"invalid_manifest",
			['"hooks"', "Claude Code", ".gjc/hooks/"],
		);
	});

	test("Claude Code hook array entries (matcher groups) are recognized and redirected", () => {
		expectAliasError(
			() =>
				parseManifest(
					{
						kind: "gajae-code-plugin",
						name: "x",
						version: "1.0.0",
						hooks: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo" }], source: "h.ts" }],
					},
					"/plugin/x/gajae-plugin.json",
				),
			"invalid_manifest",
			["matcher", ".gjc/hooks/", "tool_call"],
		);
	});

	test("hybrid Claude hook entries cannot hide foreign semantics behind canonical fields", () => {
		expectAliasError(
			() =>
				parseManifest(
					{
						kind: "gajae-code-plugin",
						name: "x",
						version: "1.0.0",
						hooks: [
							{
								name: "audit",
								event: "tool_call",
								target: "bash",
								phase: "before",
								path: "hooks/audit.ts",
								matcher: "Bash",
								hooks: [{ type: "command", command: "echo hidden" }],
							},
						],
					},
					"/plugin/x/gajae-plugin.json",
				),
			"invalid_manifest",
			["matcher", ".gjc/hooks/"],
		);
	});

	test("mcps and mcpServers together is a targeted conflict, not a guess", () => {
		expectAliasError(
			() =>
				parseManifest(
					{ kind: "gajae-code-plugin", name: "x", version: "1.0.0", mcps: [], mcpServers: {} },
					"/plugin/x/gajae-plugin.json",
				),
			"invalid_manifest",
			['"mcps"', '"mcpServers"'],
		);
	});
});

async function compileAliasWithMcpServers(
	manifest: Record<string, unknown>,
	files: Record<string, string> = {},
): Promise<{
	entries: GjcPluginMcpManifestEntry[];
	registryEntry: GjcPluginRegistryEntry;
	bundle: NormalizedGjcPluginBundle;
}> {
	const root = await mkTemp("gjc-alias-sec-");
	await writeManifestBundle(root, manifest);
	for (const [relativePath, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
		await fs.writeFile(path.join(root, relativePath), content);
	}
	const bundle = await compileGjcPluginBundle(root);
	const registryEntry: GjcPluginRegistryEntry = {
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
		surfaces: bundle.surfaces,
		disabledSurfaceIds: [],
	};
	return { entries: bundle.surfaces.mcps.map(s => s.config), registryEntry, bundle };
}

describe("issue #4287 acceptance 5: aliases never bypass security or collision authority", () => {
	test("alias MCP entries still pass through the install MCP security policy", async () => {
		const { entries } = await compileAliasWithMcpServers({
			kind: "gajae-code-plugin",
			name: "alias-sec",
			version: "1.0.0",
			mcpServers: { meta: { url: "http://169.254.169.254/latest/meta-data" } },
		});
		expect(entries[0]?.transport).toBe("http");
		expect(() => assertMcpInstallPolicy(entries[0] as GjcPluginMcpManifestEntry, { pluginRoot: "/tmp" })).toThrow(
			GjcPluginLoadError,
		);
	});

	test("alias stdio entries keep launcher and flag confinement", async () => {
		await expect(
			compileAliasWithMcpServers({
				kind: "gajae-code-plugin",
				name: "alias-sec",
				version: "1.0.0",
				mcpServers: { shell: { command: "sh", args: ["-c", "evil"] } },
			}),
		).rejects.toBeInstanceOf(GjcPluginLoadError);
	});

	test("alias MCP names collide with canonical names in the registry authority", async () => {
		const { registryEntry: aliasedEntry, bundle: aliasedBundle } = await compileAliasWithMcpServers(
			{
				kind: "gajae-code-plugin",
				name: "alias-sec",
				version: "1.0.0",
				mcpServers: { shared: { command: "bun", args: ["s.ts"] } },
			},
			{ "s.ts": "export {};\n" },
		);
		const canonicalRoot = await mkTemp("gjc-alias-canonical-sec-");
		await writeManifestBundle(canonicalRoot, {
			kind: "gajae-code-plugin",
			name: "canonical-sec",
			version: "1.0.0",
			mcps: [{ name: "shared", transport: "stdio", command: "bun", args: ["s.ts"] }],
		});
		await fs.writeFile(path.join(canonicalRoot, "s.ts"), "export {};\n");
		const canonical = await compileGjcPluginBundle(canonicalRoot);
		const canonicalEntry: GjcPluginRegistryEntry = {
			name: canonical.name,
			version: canonical.version,
			scope: "project",
			enabled: true,
			pluginRoot: canonical.root,
			manifestPath: canonical.manifestPath,
			manifestHash: canonical.manifestHash,
			source: { kind: "path", uri: canonicalRoot, resolvedAt: new Date().toISOString() },
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			copiedFiles: canonical.files,
			surfaces: canonical.surfaces,
			disabledSurfaceIds: [],
		};
		// Installing the canonical bundle first means the alias bundle must not
		// steal the name; installing the alias first must block the canonical one.
		expect(() => validateInstallPlan(aliasedBundle, [canonicalEntry])).toThrow(GjcPluginLoadError);
		expect(() => validateInstallPlan(canonical, [aliasedEntry])).toThrow(GjcPluginLoadError);
	});

	test("alias env is rejected at parse time, never silently dropped into the registry", async () => {
		const root = await mkTemp("gjc-alias-env-");
		await writeManifestBundle(root, {
			kind: "gajae-code-plugin",
			name: "alias-env",
			version: "1.0.0",
			mcpServers: { db: { command: "bun", args: ["s.ts"], env: { DB_URL: "x" } } },
		});
		await expect(compileGjcPluginBundle(root)).rejects.toThrow(GjcPluginLoadError);
	});

	test("alias MCP policy failure leaves the target scope untouched", async () => {
		const cwd = await mkProjectCwd();
		const root = await mkTemp("gjc-alias-policy-atomic-");
		await writeManifestBundle(root, {
			kind: "gajae-code-plugin",
			name: "alias-policy-atomic",
			version: "1.0.0",
			mcpServers: { metadata: { url: "http://169.254.169.254/latest/meta-data" } },
		});
		const scopeRoot = path.join(cwd, ".gjc", "gjc-plugins");
		await expect(fs.stat(scopeRoot)).rejects.toThrow();

		await expect(installGjcBundle({ cwd }, "project", root)).rejects.toMatchObject({ code: "security_policy" });
		await expect(fs.stat(scopeRoot)).rejects.toThrow();
	});
});

describe("issue #4287 adversarial: shape attacks, credentials, traversal, determinism", () => {
	test("mcpServers as an array is a shape attack and is rejected", () => {
		expectAliasError(
			() =>
				parseManifest(
					{ kind: "gajae-code-plugin", name: "x", version: "1.0.0", mcpServers: [{ command: "bun" }] },
					"/plugin/x/gajae-plugin.json",
				),
			"invalid_manifest",
			['"mcpServers"', "map"],
		);
	});

	test("canonical mcps as a map is still rejected (shape contract unchanged)", () => {
		expectAliasError(
			() =>
				parseManifest(
					{ kind: "gajae-code-plugin", name: "x", version: "1.0.0", mcps: { docs: { transport: "stdio" } } },
					"/plugin/x/gajae-plugin.json",
				),
			"invalid_manifest",
			["mcps must be an array"],
		);
	});

	test("alias url with embedded credentials fails the install MCP policy", async () => {
		const { entries } = await compileAliasWithMcpServers({
			kind: "gajae-code-plugin",
			name: "alias-sec",
			version: "1.0.0",
			mcpServers: { secret: { url: "https://user:pass@example.com/mcp" } },
		});
		expect(() => assertMcpInstallPolicy(entries[0] as GjcPluginMcpManifestEntry, { pluginRoot: "/tmp" })).toThrow(
			GjcPluginLoadError,
		);
	});

	test("alias stdio args cannot traverse out of the plugin root", async () => {
		const root = await mkTemp("gjc-alias-traverse-");
		await writeManifestBundle(root, {
			kind: "gajae-code-plugin",
			name: "alias-traverse",
			version: "1.0.0",
			mcpServers: { evil: { command: "bun", args: ["../escape.ts"] } },
		});
		await expect(compileGjcPluginBundle(root)).rejects.toThrow(GjcPluginLoadError);
	});

	test("compiling the same alias bundle twice is byte-deterministic", async () => {
		const root = await mkTemp("gjc-alias-det-");
		await writeManifestBundle(root, aliasManifest);
		await fs.mkdir(path.join(root, "mcp"), { recursive: true });
		await fs.writeFile(path.join(root, "mcp", "server.ts"), "export default {};\n");
		const [a, b] = [await compileGjcPluginBundle(root), await compileGjcPluginBundle(root)];
		expect(b.manifestHash).toBe(a.manifestHash);
		expect(JSON.stringify(b.surfaces)).toBe(JSON.stringify(a.surfaces));
		expect(JSON.stringify(b.files)).toBe(JSON.stringify(a.files));
	});

	test("force update: alias bundle upgrades through preview/apply with surface deltas", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkTemp("gjc-alias-update-src-");
		await writeManifestBundle(source, {
			kind: "gajae-code-plugin",
			name: "alias-update",
			version: "1.0.0",
			mcpServers: { docs: { type: "stdio", command: "bun", args: ["mcp/server.ts"], cwd: "." } },
		});
		await fs.mkdir(path.join(source, "mcp"), { recursive: true });
		await fs.writeFile(path.join(source, "mcp", "server.ts"), "export default {};\n");
		const installed = await installGjcBundle({ cwd }, "project", source);
		expect(installed.ok).toBe(true);
		if (!installed.ok) throw new Error(installed.error.code);
		const identity = installed.value.summary.identity;

		// Direct reinstall of the same source is refused (must upgrade).
		const refused = await installGjcBundle({ cwd }, "project", source);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("expected refusal");
		expect(refused.error.code).toBe("already_installed_use_upgrade");

		// Evolve the alias source (version bump + added server) and upgrade.
		await writeManifestBundle(source, {
			kind: "gajae-code-plugin",
			name: "alias-update",
			version: "2.0.0",
			mcpServers: {
				docs: { type: "stdio", command: "bun", args: ["mcp/server.ts"], cwd: "." },
				extra: { url: "https://example.com/extra" },
			},
		});
		const preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(preview.value.changed).toBe(true);
		expect(preview.value.addedSurfaceIds).toContain("mcp:extra");
		expect(preview.value.removedSurfaceIds).toEqual([]);
		const applied = await applyGjcBundleUpdate({ cwd }, preview.value.token);
		expect(applied.ok).toBe(true);
		if (!applied.ok) throw new Error(applied.error.code);
		expect(applied.value.status).toBe("updated");
		expect(applied.value.summary.version).toBe("2.0.0");
		expect(applied.value.summary.surfaces.some(s => s.name === "extra")).toBe(true);
	});
});

async function mkProjectCwd(): Promise<string> {
	const cwd = await mkTemp("gjc-alias-cwd-");
	await fs.mkdir(path.join(cwd, ".gjc"), { recursive: true });
	return cwd;
}

async function installAliasBundle(cwd: string): Promise<string> {
	const root = await mkTemp("gjc-alias-install-");
	await writeManifestBundle(root, aliasManifest);
	await fs.mkdir(path.join(root, "mcp"), { recursive: true });
	await fs.writeFile(path.join(root, "mcp", "server.ts"), "export default {};\n");
	const result = await installGjcBundle({ cwd }, "project", root);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.code);
	expect(result.value.summary.surfaces.some(s => s.kind === "mcp" && s.name === "docs")).toBe(true);
	expect(result.value.summary.surfaces.some(s => s.kind === "mcp" && s.name === "remote")).toBe(true);
	expect(result.value.summary.quarantined).toBe(false);
	return root;
}

describe("issue #4287 acceptance 4: install lifecycle remains covered for alias bundles", () => {
	test("alias bundle installs, normalizes in the registry, toggles, and uninstalls", async () => {
		const cwd = await mkProjectCwd();
		const root = await installAliasBundle(cwd);
		const registry = await readRegistry("project", cwd);
		const entry = registry.plugins.find(p => p.name === "alias-equivalence");
		expect(entry).toBeDefined();
		if (!entry) throw new Error("missing entry");
		// The registry stores the canonical normalized surface, extension id
		// derived from the aliased server name.
		expect(entry.surfaces.mcps.map(m => m.name).sort()).toEqual(["docs", "remote"]);
		expect(entry.surfaces.mcps[0]?.extensionId).toBe("mcp:docs");
		expect(entry.surfaces.mcps[1]?.extensionId).toBe("mcp:remote");

		// Disable + re-enable one surface.
		const identity = { kind: "gjc-bundle", scope: "project", name: "alias-equivalence" } as const;
		const disabled = await setGjcBundleSurfaceEnabled({ cwd }, identity, "mcp:docs", false);
		expect(disabled.ok).toBe(true);
		if (!disabled.ok) throw new Error(disabled.error.code);
		const after = await readRegistry("project", cwd);
		const toggled = after.plugins.find(p => p.name === "alias-equivalence");
		expect(toggled?.disabledSurfaceIds).toContain("mcp:docs");

		const uninstalled = await uninstallGjcBundle({ cwd }, identity);
		expect(uninstalled.ok).toBe(true);
		const registryAfter = await readRegistry("project", cwd);
		expect(registryAfter.plugins.find(p => p.name === "alias-equivalence")).toBeUndefined();
		await fs.rm(root, { recursive: true, force: true });
	});

	test("alias bundle hash-drift is detected after the installed manifest is tampered", async () => {
		const cwd = await mkProjectCwd();
		await installAliasBundle(cwd);
		const registry = await readRegistry("project", cwd);
		const entry = registry.plugins.find(p => p.name === "alias-equivalence");
		expect(entry).toBeDefined();
		if (!entry) throw new Error("missing entry");
		expect(await verifyEntryHashes(entry)).toBeNull();

		// Tamper the INSTALLED manifest copy (the source root is only the
		// install-time input; the registry owns the installed copy).
		const tampered = (await fs.readFile(entry.manifestPath, "utf8")).replace('"remote"', '"remote2"');
		await fs.writeFile(entry.manifestPath, tampered);
		const drift = await verifyEntryHashes(entry);
		expect(drift).not.toBeNull();
		if (drift) {
			expect(drift.surfaceId).toContain("alias-equivalence");
			expect(drift.code).toBe("runtime_mismatch");
		}
	});

	test("prototype-like alias names remain own keys in the runtime MCP config map", async () => {
		const cwd = await mkProjectCwd();
		const root = await mkTemp("gjc-alias-prototype-runtime-");
		await writeManifestBundle(root, {
			kind: "gajae-code-plugin",
			name: "prototype-runtime",
			version: "1.0.0",
			mcpServers: { constructor: { url: "https://example.com/constructor" } },
		});
		const installed = await installGjcBundle({ cwd }, "project", root);
		expect(installed.ok).toBe(true);

		const runtime = await buildPluginMcpConfigs({ cwd });
		expect(Object.getPrototypeOf(runtime.configs)).toBeNull();
		expect(Object.hasOwn(runtime.configs, "constructor")).toBe(true);
		expect(runtime.configs.constructor).toMatchObject({
			type: "http",
			url: "https://example.com/constructor",
		});
	});
});
