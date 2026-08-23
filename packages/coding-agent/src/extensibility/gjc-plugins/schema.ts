import {
	GJC_PLUGIN_KIND,
	GJC_SUBSKILL_PARENT_AGENTS,
	type GjcPluginAgentAppendixManifestEntry,
	type GjcPluginAppendixManifestEntry,
	type GjcPluginHookManifestEntry,
	GjcPluginLoadError,
	type GjcPluginLoadErrorCode,
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
 * Each rejection is a targeted migration diagnostic naming the safe
 * alternative (the loose surface or the sub-skill binding model) instead of a
 * generic forbidden-key error.
 */
const FORBIDDEN_MANIFEST_KEYS = ["skills", "slash-commands", "commands", "agents"] as const;

type ForbiddenManifestKey = (typeof FORBIDDEN_MANIFEST_KEYS)[number];

const FORBIDDEN_SURFACE_DIAGNOSTICS: Record<ForbiddenManifestKey, string> = {
	skills: `Forbidden GJC plugin surface "skills": bundles may only EXTEND the four bundled workflow skills (deep-interview, ralplan, ultragoal, autoresearch) and the four role agents (executor, architect, planner, critic), never register a new top-level skill. Bind an inline sub-skill with the canonical "subskills" surface (frontmatter binds_to/phase/activation_arg), or drop the manifest and use the loose surface .gjc/skills/<name>/SKILL.md (project) / <agentDir>/skills/<name>/SKILL.md (user; see gjc config path).`,
	"slash-commands": `Forbidden GJC plugin surface "slash-commands": bundles cannot register slash commands. Use the loose surface .gjc/commands/<name> (TypeScript module) or a markdown slash-command file instead.`,
	commands: `Forbidden GJC plugin surface "commands" (Claude Code plugin.json vocabulary): bundles cannot register slash commands. Use the loose surface .gjc/commands/<name> (TypeScript module) or a markdown slash-command file instead.`,
	agents: `Forbidden GJC plugin surface "agents" (Claude Code plugin.json vocabulary): bundles cannot register top-level agents; executor/architect/planner/critic are protected. Bind a sub-skill to an existing agent with the canonical "subskills" surface (frontmatter binds_to: one of executor|architect|planner|critic, phase, activation_arg) instead.`,
};

/**
 * Ambiguous legacy aliases whose shape cannot be mapped onto the canonical
 * compiled representation. Rejected as `unsupported_surface` with a targeted
 * migration diagnostic naming the canonical form, never a generic unknown-key
 * error. `mcp` is singular and shape-ambiguous (array entry vs single object),
 * so it stays rejected; `mcpServers` is accepted and normalized (below).
 */
const AMBIGUOUS_ALIAS_KEYS = ["mcp"] as const;

/**
 * Accepted compatibility aliases from Claude Code / Codex-familiar plugin
 * vocabulary. Each is normalized into the canonical compiled representation at
 * parse time, so a canonical manifest and its alias compile to byte-equivalent
 * normalized surfaces. Only aliases with an unambiguous semantic mapping are
 * accepted here; anything else falls into AMBIGUOUS_ALIAS_KEYS or a targeted
 * per-field migration diagnostic.
 */
const ACCEPTED_ALIAS_KEYS = ["mcpServers"] as const;

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
	...ACCEPTED_ALIAS_KEYS,
]);

/**
 * Per-server keys the `mcpServers` alias accepts and maps onto the canonical
 * `mcps` entry (`type` is Claude Code / loose mcp.json vocabulary for the
 * canonical `transport` field).
 */
const MCP_SERVER_ALIAS_KEYS = new Set(["type", "command", "args", "cwd", "url"]);

/**
 * Per-server keys that exist in GJC's loose mcp.json surface but have NO
 * equivalent in the canonical plugin-manifest `mcps` entry. An alias cannot
 * preserve their semantics, so they raise a targeted migration diagnostic
 * naming the loose surface that can hold them.
 */
const MCP_SERVER_ALIAS_UNSUPPORTED_KEYS = [
	"env",
	"auth",
	"oauth",
	"headers",
	"enabled",
	"timeout",
	"autoload",
	"noInheritEnv",
] as const;

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

/**
 * A bundle name is echoed by the CLI, rendered in Settings, and used to derive
 * a directory segment, so it is constrained at the parse boundary rather than
 * sanitized at every display site. Anything outside this set — control or ANSI
 * sequences, path separators, whitespace, or credential-looking text — is
 * rejected before it can ever be stored.
 */
function manifestSafeName(
	value: unknown,
	field: string,
	manifestPath: string,
	code: GjcPluginLoadErrorCode = "invalid_manifest",
): string {
	const name =
		code === "invalid_frontmatter"
			? requireNonEmptyString(value, field, manifestPath)
			: manifestString(value, field, manifestPath);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
		throw new GjcPluginLoadError(
			code,
			`GJC plugin ${field} must be 1-128 characters of letters, digits, dot, underscore, or hyphen (${manifestPath})`,
		);
	}
	return name;
}

/**
 * Free-form prose that is rendered into prompts or UI. It is not constrained to
 * the identifier grammar, but control and ANSI characters are rejected so a
 * manifest cannot inject escape sequences into a rendered surface.
 */
function manifestSafeProse(
	value: unknown,
	field: string,
	manifestPath: string,
	code: GjcPluginLoadErrorCode = "invalid_manifest",
): string {
	const text = requireNonEmptyString(value, field, manifestPath);
	// C0, DEL, and the C1 block: a single-byte CSI (U+009B) is an escape
	// introducer on its own, so rejecting only C0 leaves the same injection open.
	if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
		throw new GjcPluginLoadError(code, `GJC plugin ${field} must not contain control characters (${manifestPath})`);
	}
	return text;
}

/**
 * A version string is rendered next to the bundle name everywhere the bundle
 * appears, so it is constrained to printable version-like characters.
 */
function manifestSafeVersion(value: unknown, manifestPath: string): string {
	const version = manifestString(value, "version", manifestPath);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(version)) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`GJC plugin version must be 1-64 characters of letters, digits, dot, plus, underscore, or hyphen (${manifestPath})`,
		);
	}
	return version;
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
		const name = manifestSafeName(entry.name, `tools[${index}].name`, manifestPath);
		const path = manifestString(entry.path, `tools[${index}].path`, manifestPath);
		const description =
			entry.description === undefined
				? undefined
				: manifestSafeProse(entry.description, `tools[${index}].description`, manifestPath);
		const sha256 =
			entry.sha256 === undefined ? undefined : manifestString(entry.sha256, `tools[${index}].sha256`, manifestPath);
		const schemaPath =
			(entry.schemaPath ?? entry.schema_path) === undefined
				? undefined
				: manifestString(entry.schemaPath ?? entry.schema_path, `tools[${index}].schemaPath`, manifestPath);
		const schema = entry.schema ?? entry.inputSchema ?? entry.input_schema ?? entry.parameters;
		return { name, path, description, sha256, schema, schemaPath, surface: "always-on" };
	});
}

function parseHooks(value: unknown, manifestPath: string): GjcPluginHookManifestEntry[] {
	const raw = optionalArray(value, "hooks", manifestPath);
	return raw.map((entry, index) => {
		// Claude Code plugin.json hook entries are matcher groups ({ matcher,
		// hooks, source }) with no `name`; a GJC bundle hook is a single
		// constrained file with a declared event. The shapes cannot be mapped
		// onto each other, so give the author a targeted migration diagnostic
		// instead of a generic missing-field error.
		if (isRecord(entry) && ("matcher" in entry || "hooks" in entry || "source" in entry)) {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: hooks[${index}] looks like a Claude Code plugin.json hook entry ({ matcher, hooks, source }), which cannot be preserved as a GJC bundle hook. Canonical GJC bundle hooks are { name, event, target?, phase?, path, sha256? } (event "tool_call"/"tool_result" with target/phase, or a session event). For unconstrained local hooks, use the loose surface .gjc/hooks/pre/<tool>.ts / .gjc/hooks/post/<tool>.ts.`,
			);
		}
		if (!isRecord(entry)) {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: hooks[${index}] must be an object`,
			);
		}
		const name = manifestSafeName(entry.name, `hooks[${index}].name`, manifestPath);
		// event/target become part of the hook surface ID
		// (`hook:<event>:<phase>:<target>:<name>`), which is rendered and printed.
		const event = manifestSafeName(entry.event, `hooks[${index}].event`, manifestPath);
		const path = manifestString(entry.path, `hooks[${index}].path`, manifestPath);
		const target =
			entry.target === undefined
				? undefined
				: manifestSafeName(entry.target, `hooks[${index}].target`, manifestPath);
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

function parseMcpEntry(entry: unknown, field: string, manifestPath: string): GjcPluginMcpManifestEntry {
	if (!isRecord(entry)) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: ${field} must be an object`,
		);
	}
	const name = manifestSafeName(entry.name, `${field}.name`, manifestPath);
	const transport = entry.transport;
	if (typeof transport !== "string" || !MCP_TRANSPORTS.includes(transport as GjcPluginMcpTransport)) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: ${field}.transport must be one of ${MCP_TRANSPORTS.join(", ")}`,
		);
	}
	const command =
		entry.command === undefined ? undefined : manifestString(entry.command, `${field}.command`, manifestPath);
	const url = entry.url === undefined ? undefined : manifestString(entry.url, `${field}.url`, manifestPath);
	const cwd = entry.cwd === undefined ? undefined : manifestString(entry.cwd, `${field}.cwd`, manifestPath);
	let args: string[] | undefined;
	if (entry.args !== undefined) {
		if (!Array.isArray(entry.args) || !entry.args.every(item => typeof item === "string")) {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: ${field}.args must be a string array`,
			);
		}
		args = [...(entry.args as string[])];
	}
	let headers: Record<string, string> | undefined;
	if (entry.headers !== undefined) {
		if (!isRecord(entry.headers) || !Object.values(entry.headers).every(v => typeof v === "string")) {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: ${field}.headers must be a string map`,
			);
		}
		headers = { ...(entry.headers as Record<string, string>) };
	}
	const sha256 =
		entry.sha256 === undefined ? undefined : manifestString(entry.sha256, `${field}.sha256`, manifestPath);
	return { name, transport: transport as GjcPluginMcpTransport, command, args, cwd, url, headers, sha256 };
}

function parseMcps(value: unknown, manifestPath: string): GjcPluginMcpManifestEntry[] {
	const raw = optionalArray(value, "mcps", manifestPath);
	return raw.map((entry, index) => parseMcpEntry(entry, `mcps[${index}]`, manifestPath));
}

/**
 * Claude Code / Codex-familiar `mcpServers` map (server name -> server config),
 * normalized into the canonical `mcps` array. Only fields with an unambiguous
 * canonical equivalent are accepted; anything the canonical `mcps` entry cannot
 * preserve (env, auth, oauth, headers, enablement/timeout/autoload controls, unknown
 * keys) raises a targeted migration diagnostic naming the exact alternative.
 */
function normalizeMcpServersAlias(value: unknown, manifestPath: string): GjcPluginMcpManifestEntry[] {
	if (!isRecord(value)) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: "mcpServers" must be a map of server name to configuration`,
		);
	}
	const entries: GjcPluginMcpManifestEntry[] = [];
	const serverEntries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	for (const [serverName, rawEntry] of serverEntries) {
		if (!isRecord(rawEntry)) {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: mcpServers["${serverName}"] must be an object`,
			);
		}
		for (const key of Object.keys(rawEntry)) {
			if ((MCP_SERVER_ALIAS_UNSUPPORTED_KEYS as readonly string[]).includes(key)) {
				throw new GjcPluginLoadError(
					"unsupported_surface",
					`mcpServers["${serverName}"] uses "${key}", which the canonical GJC bundle runtime cannot preserve end to end. "${key}" is supported by GJC's canonical loose MCP surface (mcpServers map in <project>/.gjc/mcp.json or ~/.gjc/agent/mcp.json): move this server there directly or through the /extensions import flow, or drop "${key}" from the bundle manifest (${manifestPath})`,
				);
			}
			if (!MCP_SERVER_ALIAS_KEYS.has(key)) {
				throw new GjcPluginLoadError(
					"unsupported_surface",
					`mcpServers["${serverName}"] has unknown key "${key}". Canonical "mcps" entries support name, transport, command, args, cwd, url, headers, sha256; the "mcpServers" alias additionally accepts "type" for the transport (${manifestPath})`,
				);
			}
		}
		let transport: GjcPluginMcpTransport;
		if (rawEntry.type !== undefined) {
			if (typeof rawEntry.type !== "string" || !MCP_TRANSPORTS.includes(rawEntry.type as GjcPluginMcpTransport)) {
				throw new GjcPluginLoadError(
					"invalid_manifest",
					`Invalid GJC plugin manifest at ${manifestPath}: mcpServers["${serverName}"].type must be one of ${MCP_TRANSPORTS.join(", ")}`,
				);
			}
			transport = rawEntry.type as GjcPluginMcpTransport;
		} else if (typeof rawEntry.command === "string" && typeof rawEntry.url === "string") {
			// Both stdio (command) and url transports declared without a type:
			// ambiguous, refuse rather than guess.
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: mcpServers["${serverName}"] declares both "command" and "url" without a "type". Set "type" to "stdio" (command) or "http"/"sse" (url).`,
			);
		} else if (typeof rawEntry.command === "string") {
			// Claude Code defaults: a command means stdio.
			transport = "stdio";
		} else if (typeof rawEntry.url === "string") {
			// A bare url means an http transport; sse must be declared explicitly.
			transport = "http";
		} else {
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Invalid GJC plugin manifest at ${manifestPath}: mcpServers["${serverName}"] cannot determine a transport. Set "type" (stdio | http | sse), or provide "command" (stdio) or "url" (http)`,
			);
		}
		const incompatibleKeys = transport === "stdio" ? ["url"] : ["command", "args", "cwd"];
		for (const key of incompatibleKeys) {
			if (rawEntry[key] !== undefined) {
				throw new GjcPluginLoadError(
					"unsupported_surface",
					`mcpServers["${serverName}"] uses "${key}" with transport "${transport}", but the GJC bundle runtime cannot preserve that field for this transport. Use only command/args/cwd for stdio or url for http/sse, or move the server to the canonical loose .gjc/mcp.json surface (${manifestPath})`,
				);
			}
		}
		entries.push(
			parseMcpEntry(
				{
					name: serverName,
					transport,
					...pickOptional(rawEntry, ["command", "args", "cwd", "url"]),
				},
				`mcpServers["${serverName}"]`,
				manifestPath,
			),
		);
	}
	return entries;
}

function pickOptional(entry: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		const value = entry[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

function parseAppendixEntry(entry: unknown, field: string, manifestPath: string): GjcPluginAppendixManifestEntry {
	if (!isRecord(entry)) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: ${field} must be an object`,
		);
	}
	const name = manifestSafeName(entry.name, `${field}.name`, manifestPath);
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
			throw new GjcPluginLoadError(
				"forbidden_surface",
				`GJC plugin manifest at ${manifestPath}: ${FORBIDDEN_SURFACE_DIAGNOSTICS[key]}`,
			);
		}
	}

	for (const key of AMBIGUOUS_ALIAS_KEYS) {
		if (Object.hasOwn(raw, key)) {
			throw new GjcPluginLoadError(
				"unsupported_surface",
				`Unsupported GJC plugin surface "${key}" in ${manifestPath}: the singular "mcp" shape is ambiguous. Use the canonical "mcps" (array of { name, transport, command, args, cwd, url, headers }) or the Claude Code-compatible "mcpServers" map alias.`,
			);
		}
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_MANIFEST_KEYS.has(key)) {
			throw new GjcPluginLoadError(
				"unsupported_surface",
				`Unsupported GJC plugin surface in ${manifestPath}: ${key}. Known GJC bundle keys: ${[...KNOWN_MANIFEST_KEYS].sort().join(", ")}.`,
			);
		}
	}

	// Claude Code plugin.json declares hooks as an event-keyed map; GJC bundle
	// hooks are a constrained array. Detect the foreign shape and explain the
	// canonical form (and the loose hook surface) instead of a generic
	// must-be-an-array error.
	if (raw.hooks !== undefined && !Array.isArray(raw.hooks)) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: "hooks" must be an array of { name, event, target?, phase?, path, sha256? }. A Claude Code plugin.json "hooks" map (event-keyed matcher groups) cannot be preserved as a GJC bundle hook. For unconstrained local hooks, use the loose surface .gjc/hooks/pre/<tool>.ts / .gjc/hooks/post/<tool>.ts.`,
		);
	}

	if (raw.kind !== GJC_PLUGIN_KIND) {
		throw new GjcPluginLoadError(
			"invalid_kind",
			`Invalid GJC plugin kind in ${manifestPath}: expected ${GJC_PLUGIN_KIND}`,
		);
	}

	if (raw.mcps !== undefined && raw.mcpServers !== undefined) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: use either the canonical "mcps" array or the "mcpServers" alias map, not both.`,
		);
	}

	const name = manifestSafeName(raw.name, "name", manifestPath);
	const version = manifestSafeVersion(raw.version, manifestPath);

	return {
		name,
		version,
		kind: GJC_PLUGIN_KIND,
		subskills: optionalStringArray(raw.subskills, "subskills", manifestPath),
		tools: parseTools(raw.tools, manifestPath),
		hooks: parseHooks(raw.hooks, manifestPath),
		mcps:
			raw.mcpServers !== undefined
				? normalizeMcpServersAlias(raw.mcpServers, manifestPath)
				: parseMcps(raw.mcps, manifestPath),
		systemAppendix: parseSystemAppendix(raw.system_appendix, manifestPath),
		agentAppendix: parseAgentAppendix(raw["agent-appendix"], manifestPath),
	};
}

export function parseSubskillFrontmatter(fm: Record<string, unknown>, filePath: string): SubskillFrontmatter {
	return {
		// Name and activation_arg become part of the surface ID
		// (`subskill:<parent>:<phase>:<arg>`) and are rendered, so they share the
		// identifier grammar. binds_to and phase are separately checked against
		// the known parent/phase sets. The description is prose and may not be
		// constrained to that grammar, but must not carry control characters into
		// a rendered prompt.
		name: manifestSafeName(fm.name, "name", filePath, "invalid_frontmatter"),
		binds_to: requireNonEmptyString(fm.binds_to, "binds_to", filePath),
		phase: requireNonEmptyString(fm.phase, "phase", filePath),
		activation_arg: manifestSafeName(fm.activation_arg, "activation_arg", filePath, "invalid_frontmatter"),
		description: manifestSafeProse(fm.description, "description", filePath, "invalid_frontmatter"),
	};
}
