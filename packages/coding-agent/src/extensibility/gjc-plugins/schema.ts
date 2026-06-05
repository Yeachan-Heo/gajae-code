import { GJC_PLUGIN_KIND, GjcPluginLoadError, type GjcPluginManifest, type SubskillFrontmatter } from "./types";

const FORBIDDEN_MANIFEST_KEYS = ["skills", "slash-commands", "commands", "hooks", "mcp", "mcpServers", "agents"];

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

function requireStringArray(value: unknown, field: string, manifestPath: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: ${field} must be a string array`,
		);
	}
	return [...value];
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

	if (raw.kind !== GJC_PLUGIN_KIND) {
		throw new GjcPluginLoadError(
			"invalid_kind",
			`Invalid GJC plugin kind in ${manifestPath}: expected ${GJC_PLUGIN_KIND}`,
		);
	}
	if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: name must be a non-empty string`,
		);
	}
	if (typeof raw.version !== "string" || raw.version.trim().length === 0) {
		throw new GjcPluginLoadError(
			"invalid_manifest",
			`Invalid GJC plugin manifest at ${manifestPath}: version must be a non-empty string`,
		);
	}

	return {
		name: raw.name,
		version: raw.version,
		kind: GJC_PLUGIN_KIND,
		subskills: requireStringArray(raw.subskills, "subskills", manifestPath),
		tools: requireStringArray(raw.tools, "tools", manifestPath),
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
