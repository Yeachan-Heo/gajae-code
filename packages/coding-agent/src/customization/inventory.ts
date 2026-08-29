/**
 * Inventory aggregation for the `/extensions` umbrella customization surface.
 *
 * Status authority is the runtime's own contracts, not a parallel state model:
 * - Skills: `listNativeSkillsForManagement` (#4285) — the authoritative
 *   discovery/policy model (trust, include/ignore, disabledExtensions,
 *   bundled-name protection). A narrow supplemental scan flags SKILL.md files
 *   the management loader rejects as `invalid` rows.
 * - Hooks: canonical `<root>/hooks/<pre|post>/` layout with the runtime's
 *   project-first, first-wins dedupe key (`<type>:<tool>:<name>`); losers are
 *   shown as `shadowed`.
 * - MCPs: canonical config files for both scopes with the runtime's
 *   project-first precedence and the union of disabled markers; malformed
 *   files surface as `invalid` rows without leaking raw JSON.
 *
 * All display fields are secret-safe: env/header values are never rendered,
 * and command/argument text is masked for token-shaped assignments.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@gajae-code/utils";
import { mcpCapability } from "../capability/mcp";
import { listNativeSkillsForManagement, type SkillManagementPolicy } from "../extensibility/skill-management";
import { readMCPConfigFile } from "../runtime-mcp/config-writer";
import type { CustomizationSurface, GjcScope, InventoryRow, InventoryStatus } from "./types";
import { resolveScopePaths, scopeLabel } from "./types";

/** Frontmatter key written by the import flow to record provenance. */
export const IMPORTED_FROM_FRONTMATTER_KEY = "x-gjc-imported-from";

export interface LoadCustomizationInventoryOptions {
	cwd: string;
	/** Runtime home override (tests); defaults to the process home. */
	home?: string;
	/** Owning session agent directory for global customization surfaces. */
	agentDir?: string;
	/** Resolver-owned profile classification captured at session creation. */
	profileAuthority?: "default" | "custom";
	/** Skill management policy snapshot (trust, include/ignore, disabledExtensions). */
	policy?: SkillManagementPolicy;
	/** Disabled extension ids (`skill:<name>` / `mcp:<name>`) from settings. */
	disabledExtensions?: string[];
}

export interface CustomizationInventory {
	rows: InventoryRow[];
	warnings: string[];
}

/** Stable row identity used for selection and mutations. */
export function inventoryRowId(surface: CustomizationSurface, scope: GjcScope, rowPath: string): string {
	return `${surface}:${scope}:${rowPath}`;
}

// ---------------------------------------------------------------------------
// Display redaction
// ---------------------------------------------------------------------------

function redactServerForDisplay(server: Record<string, unknown>): Record<string, unknown> {
	return {
		type: typeof server.type === "string" ? server.type : undefined,
		enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
		autoload: typeof server.autoload === "boolean" ? server.autoload : undefined,
		sharing: typeof server.sharing === "string" ? server.sharing : undefined,
		timeout: typeof server.timeout === "number" ? server.timeout : undefined,
		command: server.command === undefined ? undefined : "[command redacted]",
		args: server.args === undefined ? undefined : "[arguments redacted]",
		url: server.url === undefined ? undefined : "[URL redacted]",
		envKeys: server.env && typeof server.env === "object" ? Object.keys(server.env) : undefined,
		headerKeys: server.headers && typeof server.headers === "object" ? Object.keys(server.headers) : undefined,
	};
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

async function readImportMarker(skillPath: string): Promise<string | null> {
	try {
		const content = await fs.readFile(skillPath, "utf-8");
		const { frontmatter } = parseFrontmatter(content, { level: "off" });
		// parseFrontmatter camelCases keys: x-gjc-imported-from → xGjcImportedFrom.
		const marker = frontmatter[IMPORTED_FROM_FRONTMATTER_KEY] ?? frontmatter.xGjcImportedFrom;
		return typeof marker === "string" ? marker : null;
	} catch {
		return null;
	}
}

function importedProductLabel(marker: string): string {
	return marker === "claude-code" ? "Claude Code" : marker === "codex" ? "Codex" : marker;
}

async function loadSkillRows(options: LoadCustomizationInventoryOptions, _warnings: string[]): Promise<InventoryRow[]> {
	const rows: InventoryRow[] = [];
	const records = await listNativeSkillsForManagement({
		cwd: options.cwd,
		home: options.home,
		agentDir: options.agentDir,
		profileAuthority: options.profileAuthority,
		policy: options.policy,
	});
	const managedPaths = new Set<string>();
	for (const record of records) {
		managedPaths.add(path.resolve(record.path));
		const scope: GjcScope = record.scope === "project" ? "project" : "global";
		const marker = await readImportMarker(record.path);
		let status: InventoryStatus;
		const diagnostics: string[] = [];
		if (options.policy?.enabled === false) {
			status = "disabled";
			diagnostics.push("native skills are disabled globally (skills.enabled=false)");
		} else if (record.enabled) {
			status = marker ? "imported" : "enabled";
		} else if (record.disabledReason === "protected") {
			// Bundled workflow skills are always active; the name is protected.
			status = "enabled";
			diagnostics.push("bundled GJC workflow skill — protected name, always available");
		} else {
			status = "disabled";
			if (record.disabledReason) diagnostics.push(`disabled (${record.disabledReason})`);
		}
		const provenance = marker ? `${record.source} · imported from ${importedProductLabel(marker)}` : record.source;
		rows.push({
			id: inventoryRowId("skills", scope, record.path),
			surface: "skills",
			name: record.name,
			displayName: record.name,
			status,
			provenance,
			path: record.path,
			scope,
			description: record.description || undefined,
			diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
			raw: { name: record.name, source: record.source, hidden: record.hidden },
		});
	}

	// Narrow supplemental pass: flag SKILL.md files the management loader
	// rejected (missing/invalid frontmatter) as invalid rows with remediation.
	for (const scope of ["project", "global"] as const) {
		const skillsDir = resolveScopePaths(scope, options.cwd, options.agentDir).skillsDir;
		let dirNames: string[];
		try {
			dirNames = (await fs.readdir(skillsDir, { withFileTypes: true }))
				.filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
				.map(entry => entry.name)
				.sort();
		} catch {
			continue;
		}
		for (const dirName of dirNames) {
			const skillPath = path.join(skillsDir, dirName, "SKILL.md");
			if (managedPaths.has(path.resolve(skillPath))) continue;
			try {
				const stat = await fs.lstat(skillPath);
				if (stat.isSymbolicLink() || !stat.isFile()) continue;
				const content = await fs.readFile(skillPath, "utf-8");
				const { frontmatter } = parseFrontmatter(content, { level: "off" });
				const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
				if (description) continue; // valid but shadowed/deduped — authority is the loader
				rows.push({
					id: inventoryRowId("skills", scope, skillPath),
					surface: "skills",
					name: dirName,
					displayName: dirName,
					status: "invalid",
					provenance: `${scopeLabel(scope)} skills`,
					path: skillPath,
					scope,
					diagnostics: ["invalid skill frontmatter: add a YAML frontmatter block with a non-empty description"],
					raw: { name: dirName },
				});
			} catch {
				// Unreadable files are simply not listed; the loader remains authority.
			}
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const HOOK_PHASES = ["pre", "post"] as const;

async function loadHookRows(options: LoadCustomizationInventoryOptions, _warnings: string[]): Promise<InventoryRow[]> {
	const rows: InventoryRow[] = [];
	// Runtime semantics: project-first, first-wins on `<type>:<tool>:<name>`.
	const seen = new Set<string>();
	for (const scope of ["project", "global"] as const) {
		const hooksDir = resolveScopePaths(scope, options.cwd, options.agentDir).hooksDir;
		for (const phase of HOOK_PHASES) {
			const phaseDir = path.join(hooksDir, phase);
			let entries: Dirent[];
			try {
				entries = await fs.readdir(phaseDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.name.startsWith(".") || !entry.isFile()) continue;
				const hookPath = path.join(phaseDir, entry.name);
				const baseName = entry.name.includes(".") ? entry.name.slice(0, entry.name.lastIndexOf(".")) : entry.name;
				const key = `${phase}:${baseName}:${entry.name}`;
				const shadowed = seen.has(key);
				seen.add(key);
				rows.push({
					id: inventoryRowId("hooks", scope, hookPath),
					surface: "hooks",
					name: entry.name,
					displayName: `${phase}/${entry.name}`,
					status: shadowed ? "shadowed" : "enabled",
					provenance: `${scopeLabel(scope)} hooks/${phase}`,
					path: hookPath,
					scope,
					description: `${phase}-tool hook for ${baseName}`,
					diagnostics: shadowed ? ["shadowed by the same hook at higher-precedence scope"] : undefined,
					raw: { name: entry.name, type: phase, tool: baseName },
				});
			}
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------
// MCPs
// ---------------------------------------------------------------------------

function mcpDescription(name: string, server: Record<string, unknown>): string {
	if (typeof server.command === "string" && server.command) {
		return `stdio MCP "${name}" (command redacted)`;
	}
	const type = typeof server.type === "string" ? server.type : "http";
	return `${type} MCP "${name}" (endpoint redacted)`;
}

async function loadMcpRows(options: LoadCustomizationInventoryOptions, warnings: string[]): Promise<InventoryRow[]> {
	const rows: InventoryRow[] = [];
	const disabledExtensions = new Set(
		(options.disabledExtensions ?? []).filter(id => id.startsWith("mcp:")).map(id => id.slice("mcp:".length)),
	);
	const scopeConfigs = await Promise.all(
		(["project", "global"] as const).map(async scope => {
			const configPath = resolveScopePaths(scope, options.cwd, options.agentDir).mcpConfigPath;
			const config = await readMCPConfigFile(configPath).catch(() => null);
			return { scope, configPath, config };
		}),
	);
	const disabledServers = new Set(
		scopeConfigs.flatMap(({ config }) => (Array.isArray(config?.disabledServers) ? config.disabledServers : [])),
	);
	// Runtime semantics: project scope wins; the user-global entry is shadowed.
	const seen = new Set<string>();
	for (const { scope, configPath: mcpConfigPath, config } of scopeConfigs) {
		if (config === null) {
			let exists = false;
			try {
				exists = (await fs.lstat(mcpConfigPath)).isFile();
			} catch {
				exists = false;
			}
			if (exists) {
				warnings.push(`${mcpConfigPath} is malformed; fix or remove it to manage MCP servers`);
				rows.push({
					id: inventoryRowId("mcps", scope, mcpConfigPath),
					surface: "mcps",
					name: path.basename(mcpConfigPath),
					displayName: path.basename(mcpConfigPath),
					status: "invalid",
					provenance: `${scopeLabel(scope)} MCP config`,
					path: mcpConfigPath,
					scope,
					diagnostics: ["malformed MCP config file; fix or remove it (contents not shown)"],
					raw: { path: mcpConfigPath },
				});
			}
			continue;
		}
		const servers = config.mcpServers ?? {};
		for (const [name, server] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
			const shadowed = seen.has(name);
			seen.add(name);
			const record = server as unknown as Record<string, unknown>;
			const validationError = mcpCapability.validate?.({
				name,
				...record,
			} as Parameters<NonNullable<typeof mcpCapability.validate>>[0]);
			const isDisabled = disabledExtensions.has(name) || disabledServers.has(name) || record.enabled === false;
			const status: InventoryStatus = validationError
				? "invalid"
				: shadowed
					? "shadowed"
					: isDisabled
						? "disabled"
						: "enabled";
			rows.push({
				id: inventoryRowId("mcps", scope, `${mcpConfigPath}#${name}`),
				surface: "mcps",
				name,
				displayName: name,
				status,
				provenance: `${scopeLabel(scope)} mcp.json`,
				path: mcpConfigPath,
				scope,
				description: mcpDescription(name, record),
				diagnostics: validationError
					? [validationError]
					: shadowed
						? ["shadowed by the same server at higher-precedence scope"]
						: undefined,
				raw: redactServerForDisplay(record),
			});
		}
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/**
 * Load the full Skills/Hooks/MCPs inventory for the `/extensions` dashboard.
 * Reads only the canonical `.gjc` scopes; foreign Claude/Codex layouts are
 * import sources handled by the explicit import flow, never managed entries.
 */
export async function loadCustomizationInventory(
	options: LoadCustomizationInventoryOptions,
): Promise<CustomizationInventory> {
	const warnings: string[] = [];
	const [skills, hooks, mcps] = await Promise.all([
		loadSkillRows(options, warnings),
		loadHookRows(options, warnings),
		loadMcpRows(options, warnings),
	]);
	return { rows: [...skills, ...hooks, ...mcps], warnings };
}
