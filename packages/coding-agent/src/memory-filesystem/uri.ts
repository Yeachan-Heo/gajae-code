import {
	FILESYSTEM_MEMORY_MAX_COMPONENT_LENGTH,
	FILESYSTEM_MEMORY_MAX_PATH_COMPONENTS,
	FILESYSTEM_MEMORY_MAX_URI_LENGTH,
	type FilesystemMemoryOutcome,
	type FilesystemMemoryScope,
	type FilesystemMemoryUri,
} from "./contracts";

const SCOPE_SET: ReadonlySet<string> = new Set(["global", "project", "project-local", "session"]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SEPARATOR = /[\\/]/;

function fail(message: string): FilesystemMemoryOutcome<never> {
	return { code: "invalid_uri", message };
}

function decodeComponent(encoded: string): FilesystemMemoryOutcome<string> {
	if (!encoded || encoded.length > FILESYSTEM_MEMORY_MAX_COMPONENT_LENGTH)
		return fail("URI component has an invalid length.");
	let decoded: string;
	try {
		decoded = decodeURIComponent(encoded);
	} catch {
		return fail("URI component contains malformed percent encoding.");
	}
	if (
		decoded === "." ||
		decoded === ".." ||
		CONTROL_CHARACTER.test(decoded) ||
		SEPARATOR.test(decoded) ||
		decoded.length > FILESYSTEM_MEMORY_MAX_COMPONENT_LENGTH
	) {
		return fail("URI component is not a safe path segment.");
	}
	return { code: "ok", value: decoded };
}

function encodeComponent(component: string): string {
	return encodeURIComponent(component);
}

/** Parses only canonical v1 logical URIs (`scope:///component/...`), never filesystem paths. */
export function parseFilesystemMemoryUri(value: string): FilesystemMemoryOutcome<FilesystemMemoryUri> {
	if (value.length === 0 || value.length > FILESYSTEM_MEMORY_MAX_URI_LENGTH) return fail("URI has an invalid length.");
	const match = /^([a-z-]+):\/\/\/(.*)$/.exec(value);
	if (!match) return fail("URI must use the scope:///path form.");
	const scopeText = match[1];
	if (!SCOPE_SET.has(scopeText)) return fail("URI scope is not supported.");
	const encodedPath = match[2];
	if (!encodedPath) return fail("URI path is required.");
	const encodedComponents = encodedPath.split("/");
	if (encodedComponents.length > FILESYSTEM_MEMORY_MAX_PATH_COMPONENTS)
		return fail("URI has too many path components.");
	const components: string[] = [];
	for (const component of encodedComponents) {
		const decoded = decodeComponent(component);
		if (decoded.code !== "ok") return decoded;
		if (encodeComponent(decoded.value) !== component) return fail("URI is not canonically encoded.");
		components.push(decoded.value);
	}
	const scope = scopeText as FilesystemMemoryScope;
	return { code: "ok", value: { scope, components, canonical: `${scope}:///${encodedComponents.join("/")}` } };
}

export function formatFilesystemMemoryUri(
	scope: FilesystemMemoryScope,
	components: readonly string[],
): FilesystemMemoryOutcome<FilesystemMemoryUri> {
	if (components.length === 0 || components.length > FILESYSTEM_MEMORY_MAX_PATH_COMPONENTS)
		return fail("URI requires a bounded non-empty path.");
	const encoded: string[] = [];
	for (const component of components) {
		if (component.length === 0 || component.length > FILESYSTEM_MEMORY_MAX_COMPONENT_LENGTH)
			return fail("URI component has an invalid length.");
		if (component === "." || component === ".." || CONTROL_CHARACTER.test(component) || SEPARATOR.test(component))
			return fail("URI component is not a safe path segment.");
		encoded.push(encodeComponent(component));
	}
	return parseFilesystemMemoryUri(`${scope}:///${encoded.join("/")}`);
}
