import type { FilesystemMemoryMapV1, FilesystemMemoryOutcome } from "./contracts";
import { parseFilesystemMemoryMapping } from "./document";
import { parseFilesystemMemoryUri } from "./uri";

export interface FilesystemMemoryMapRoute {
	readonly id: string;
	readonly targets: readonly string[];
}

function invalid(message: string): FilesystemMemoryOutcome<never> {
	return { code: "invalid_path", message };
}

function parseMapValue(text: string): FilesystemMemoryOutcome<Record<string, unknown>> {
	const nestedYaml = /^routes\s*:\s*$/m.test(text);
	const mapping = nestedYaml ? null : parseFilesystemMemoryMapping(text);
	if (
		nestedYaml &&
		(/(^|\s)[&*!]/.test(text) ||
			(text.match(/^version\s*:/gm) ?? []).length !== 1 ||
			(text.match(/^routes\s*:/gm) ?? []).length !== 1)
	)
		return invalid("MAP YAML has unsupported syntax or duplicate fields.");
	if (mapping && mapping.code !== "ok") return mapping;
	if (mapping && mapping.value.routes !== "") return mapping;
	const lines = text.split(/\r?\n/);
	const routes: Record<string, string[]> = {};
	let route: string | null = null;
	for (const line of lines) {
		if (!line.trim() || /^\s*#/.test(line) || /^version\s*:/.test(line) || /^routes\s*:\s*$/.test(line)) continue;
		const routeMatch = /^ {2}([a-z0-9]+(?:[.-][a-z0-9]+)*)\s*:\s*$/.exec(line);
		if (routeMatch) {
			if (Object.hasOwn(routes, routeMatch[1])) return invalid("MAP route is duplicated.");
			route = routeMatch[1];
			routes[route] = [];
			continue;
		}
		const targetMatch = /^ {4}-\s+(\S+)\s*$/.exec(line);
		if (targetMatch && route) {
			routes[route].push(targetMatch[1]);
			continue;
		}
		return invalid("MAP YAML must contain only routes and URI targets.");
	}
	const version = nestedYaml ? (/^version\s*:\s*1\s*$/m.test(text) ? 1 : undefined) : mapping?.value.version;
	return { code: "ok", value: { version, routes } };
}

/** Parses a v1 MAP document. Route IDs are lowercase dotted identifiers and targets are canonical logical URIs. */
export function parseFilesystemMemoryMap(text: string): FilesystemMemoryOutcome<FilesystemMemoryMapV1> {
	const parsed = parseMapValue(text);
	if (parsed.code !== "ok") return parsed;
	const value = parsed.value;
	if (Object.keys(value).some(key => key !== "version" && key !== "routes"))
		return invalid("MAP contains an unknown field.");
	if (value.version !== 1 && value.version !== "1")
		return { code: "unknown_version", message: "MAP version is not 1." };
	if (value.routes === null || typeof value.routes !== "object" || Array.isArray(value.routes))
		return invalid("MAP routes must be an object.");
	const routes: Record<string, readonly string[]> = {};
	for (const [id, targets] of Object.entries(value.routes as Record<string, unknown>)) {
		if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) || !Array.isArray(targets) || targets.length === 0)
			return invalid("MAP route is invalid.");
		const normalized: string[] = [];
		for (const target of targets) {
			if (typeof target !== "string") return invalid("MAP target is invalid.");
			const uri = parseFilesystemMemoryUri(target);
			if (uri.code !== "ok" || uri.value.canonical !== target)
				return invalid("MAP target must be a canonical logical URI.");
			normalized.push(target);
		}
		routes[id] = [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
	}
	return { code: "ok", value: { version: 1, routes } };
}

export function resolveFilesystemMemoryMapRoute(
	map: FilesystemMemoryMapV1,
	routeId: string,
): FilesystemMemoryOutcome<FilesystemMemoryMapRoute> {
	const id = routeId.trim().toLowerCase();
	if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) || id !== routeId) return invalid("Route ID must be normalized.");
	const targets = map.routes[id];
	return targets
		? { code: "ok", value: { id, targets: [...targets].sort((left, right) => left.localeCompare(right)) } }
		: { code: "not_found", message: "MAP route was not found." };
}
