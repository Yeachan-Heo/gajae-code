import {
	GJC_PLUGIN_KIND,
	GJC_SUBSKILL_PARENT_AGENTS,
	type GjcPluginAgentAppendixManifestEntry,
	type GjcPluginAppendixManifestEntry,
	type GjcPluginHookManifestEntry,
	GjcPluginLoadError,
	type GjcPluginManifest,
	type GjcPluginMcpManifestEntry,
	type GjcPluginMcpTransport,
	type GjcPluginToolManifestEntry,
	type GjcSubskillParentAgent,
	type SubskillFrontmatter,
} from "./types";

/**
 * Top-level surfaces that may never appear in a GJC plugin bundle: bundles may
 * only EXTEND existing skills/agents, never register new top-level ones.
 */
const FORBIDDEN_MANIFEST_KEYS = ["skills", "slash-commands", "commands", "agents"];

/**
 * Ambiguous legacy aliases. `mcps` is the only canonical MCP key; these are
 * rejected as `unsupported_surface` to avoid accidental legacy shape ambiguity.
 */
const UNSUPPORTED_ALIAS_KEYS = ["mcp", "mcpServers"];

const KNOWN_MANIFEST_KEYS = new Set([
	"kind",
	"name",
	"version",
	"subskills",
	"tools",
	"hooks",
	"mcps",
	"system_appendix",
	"agent-appendix",
]);

const MCP_TRANSPORTS: readonly GjcPluginMcpTransport[] = ["stdio", "http", "sse"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string, filePath: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GjcPluginLoadError(
			"invalid_frontmatter",
			`Invalid sub-skill frontmatter in ${filePath}: ${field} must be a non-empty string`,
		);
	}
	return value;
}

function manifestString(value: unknown, field: string, manifestPath: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: ${field} must be a non-empty string`,
		);
	}
	return value;
}

function optionalStringArray(value: unknown, field: string, manifestPath: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: ${field} must be a string array`,
		);
	}
	return [...(value as string[])];
}

function optionalArray(value: unknown, field: string, manifestPath: string): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: ${field} must be an array`,
		);
	}
	return value;
}

function deriveToolName(toolPath: string): string {
	const base = toolPath.split("/").pop() ?? toolPath;
	return base.replace(/\.[^.]+$/, "");
}

function parseTools(value: unknown, manifestPath: string): GjcPluginToolManifestEntry[] {
	const raw = optionalArray(value, "tools", manifestPath);
	return raw.map((entry, index) => {
		// Legacy string shorthand: subskill-scoped tool path only.
		if (typeof entry === "string") {
			if (entry.trim().length === 0) {
				throw new GjcPluginLoadError(
					"invalid_manifest",
					`Invalid GJC plugin manifest at ${manifestPath}: tools[${index}] must be a non-empty path`,
				);
			}
			return { name: deriveToolName(entry), path: entry, surface: "subskill" };
		}
		if (!isRecord(entry)) {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: tools[${index}] must be a string or object`,
			);
		}
		const name = manifestString(entry.name, `tools[${index}].name`, manifestPath);
		const path = manifestString(entry.path, `tools[${index}].path`, manifestPath);
		const description =
			entry.description === undefined
				? undefined
				: manifestString(entry.description, `tools[${index}].description`, manifestPath);
		const sha256 =
			entry.sha256 === undefined ? undefined : manifestString(entry.sha256, `tools[${index}].sha256`, manifestPath);
		return { name, path, description, sha256, surface: "always-on" };
	});
}

function parseHooks(value: unknown, manifestPath: string): GjcPluginHookManifestEntry[] {
	const raw = optionalArray(value, "hooks", manifestPath);
	return raw.map((entry, index) => {
		if (!isRecord(entry)) {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: hooks[${index}] must be an object`,
			);
		}
		const name = manifestString(entry.name, `hooks[${index}].name`, manifestPath);
		const event = manifestString(entry.event, `hooks[${index}].event`, manifestPath);
		const path = manifestString(entry.path, `hooks[${index}].path`, manifestPath);
		const target =
			entry.target === undefined ? undefined : manifestString(entry.target, `hooks[${index}].target`, manifestPath);
		let phase: "before" | "after" | undefined;
		if (entry.phase !== undefined) {
			if (entry.phase !== "before" && entry.phase !== "after") {
				throw new GjcPluginLoadError(
					"invalid_manifest",
					`Invalid GJC plugin manifest at ${manifestPath}: hooks[${index}].phase must be "before" or "after"`,
				);
			}
			phase = entry.phase;
		}
		const sha256 =
			entry.sha256 === undefined ? undefined : manifestString(entry.sha256, `hooks[${index}].sha256`, manifestPath);
		return { name, event, target, phase, path, sha256 };
	});
}

function parseMcps(value: unknown, manifestPath: string): GjcPluginMcpManifestEntry[] {
	const raw = optionalArray(value, "mcps", manifestPath);
	return raw.map((entry, index) => {
		if (!isRecord(entry)) {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: mcps[${index}] must be an object`,
			);
		}
		const name = manifestString(entry.name, `mcps[${index}].name`, manifestPath);
		const transport = entry.transport;
		if (typeof transport !== "string" || !MCP_TRANSPORTS.includes(transport as GjcPluginMcpTransport)) {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: mcps[${index}].transport must be one of ${MCP_TRANSPORTS.join(", ")}`,
			);
		}
		const command =
			entry.command === undefined
				? undefined
				: manifestString(entry.command, `mcps[${index}].command`, manifestPath);
		const url = entry.url === undefined ? undefined : manifestString(entry.url, `mcps[${index}].url`, manifestPath);
		const cwd = entry.cwd === undefined ? undefined : manifestString(entry.cwd, `mcps[${index}].cwd`, manifestPath);
		let args: string[] | undefined;
		if (entry.args !== undefined) {
			if (!Array.isArray(entry.args) || !entry.args.every(item => typeof item === "string")) {
				throw new GjcPluginLoadError(
					"invalid_manifest",
					`Invalid GJC plugin manifest at ${manifestPath}: mcps[${index}].args must be a string array`,
				);
			}
			args = [...(entry.args as string[])];
		}
		let headers: Record<string, string> | undefined;
		if (entry.headers !== undefined) {
			if (!isRecord(entry.headers) || !Object.values(entry.headers).every(v => typeof v === "string")) {
				throw new GjcPluginLoadError(
					"invalid_manifest",
					`Invalid GJC plugin manifest at ${manifestPath}: mcps[${index}].headers must be a string map`,
				);
			}
			headers = { ...(entry.headers as Record<string, string>) };
		}
		const sha256 =
			entry.sha256 === undefined ? undefined : manifestString(entry.sha256, `mcps[${index}].sha256`, manifestPath);
		return { name, transport: transport as GjcPluginMcpTransport, command, args, cwd, url, headers, sha256 };
	});
}

function parseAppendixEntry(entry: unknown, field: string, manifestPath: string): GjcPluginAppendixManifestEntry {
	if (!isRecord(entry)) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: ${field} must be an object`,
		);
	}
	const name = manifestString(entry.name, `${field}.name`, manifestPath);
	const path = entry.path === undefined ? undefined : manifestString(entry.path, `${field}.path`, manifestPath);
	// Content may be empty/whitespace here; the compiler enforces non-empty and
	// maps emptiness to invalid_appendix (not invalid_manifest).
	if (entry.content !== undefined && typeof entry.content !== "string") {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: ${field}.content must be a string`,
		);
	}
	const content = entry.content as string | undefined;
	const sha256 =
		entry.sha256 === undefined ? undefined : manifestString(entry.sha256, `${field}.sha256`, manifestPath);
	return { name, path, content, sha256 };
}

function parseSystemAppendix(value: unknown, manifestPath: string): GjcPluginAppendixManifestEntry[] {
	const raw = optionalArray(value, "system_appendix", manifestPath);
	return raw.map((entry, index) => parseAppendixEntry(entry, `system_appendix[${index}]`, manifestPath));
}

function parseAgentAppendix(value: unknown, manifestPath: string): GjcPluginAgentAppendixManifestEntry[] {
	const raw = optionalArray(value, "agent-appendix", manifestPath);
	return raw.map((entry, index) => {
		const base = parseAppendixEntry(entry, `agent-appendix[${index}]`, manifestPath);
		const agent = (entry as Record<string, unknown>).agent;
		if (typeof agent !== "string" || !GJC_SUBSKILL_PARENT_AGENTS.includes(agent as GjcSubskillParentAgent)) {
			throw new GjcPluginLoadError(
				"invalid_parent",
				`Invalid GJC plugin manifest at ${manifestPath}: agent-appendix[${index}].agent must be one of ${GJC_SUBSKILL_PARENT_AGENTS.join(", ")}`,
			);
		}
		return { ...base, agent: agent as GjcSubskillParentAgent };
	});
}

export function parseManifest(raw: unknown, manifestPath: string): GjcPluginManifest {
	if (!isRecord(raw)) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: expected object`,
		);
	}

	for (const key of FORBIDDEN_MANIFEST_KEYS) {
		if (Object.hasOwn(raw, key)) {
			throw new GjcPluginLoadError("forbidden_surface", `Forbidden GJC plugin surface in ${manifestPath}: ${key}`);
		}
	}

	for (const key of UNSUPPORTED_ALIAS_KEYS) {
		if (Object.hasOwn(raw, key)) {
			throw new GjcPluginLoadError(
				"unsupported_surface",
				`Unsupported GJC plugin surface in ${manifestPath}: ${key} (use the canonical "mcps" key)`,
			);
		}
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_MANIFEST_KEYS.has(key)) {
			throw new GjcPluginLoadError(
				"unsupported_surface",
				`Unsupported GJC plugin surface in ${manifestPath}: ${key}`,
			);
		}
	}

	if (raw.kind !== GJC_PLUGIN_KIND) {
		throw new GjcPluginLoadError(
			"invalid_kind",
			`Invalid GJC plugin kind in ${manifestPath}: expected ${GJC_PLUGIN_KIND}`,
		);
	}

	const name = manifestString(raw.name, "name", manifestPath);
	const version = manifestString(raw.version, "version", manifestPath);

	return {
		name,
		version,
		kind: GJC_PLUGIN_KIND,
		subskills: optionalStringArray(raw.subskills, "subskills", manifestPath),
		tools: parseTools(raw.tools, manifestPath),
		hooks: parseHooks(raw.hooks, manifestPath),
		mcps: parseMcps(raw.mcps, manifestPath),
		systemAppendix: parseSystemAppendix(raw.system_appendix, manifestPath),
		agentAppendix: parseAgentAppendix(raw["agent-appendix"], manifestPath),
	};
}

export function parseSubskillFrontmatter(fm: Record<string, unknown>, filePath: string): SubskillFrontmatter {
	return {
		name: requireNonEmptyString(fm.name, "name", filePath),
		binds_to: requireNonEmptyString(fm.binds_to, "binds_to", filePath),
		phase: requireNonEmptyString(fm.phase, "phase", filePath),
		activation_arg: requireNonEmptyString(fm.activation_arg, "activation_arg", filePath),
		description: requireNonEmptyString(fm.description, "description", filePath),
	};
}
