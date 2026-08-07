import { invalidInput, type MemoryResult } from "../errors";
import type { MemoryUri as IndexMemoryUri, MemoryScopeKind } from "../index";

export type MemoryUri = IndexMemoryUri;

const SCHEMES: readonly MemoryScopeKind[] = ["global", "project", "session"];
const HEX = /^[0-9A-Fa-f]$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9][0-9]*|lpt[1-9][0-9]*)(?:\..*)?$/i;

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`invalid memory URI: ${detail}`);
}

function validPercentEncoding(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== "%") continue;
		if (index + 2 >= value.length || !HEX.test(value[index + 1] ?? "") || !HEX.test(value[index + 2] ?? ""))
			return false;
		index += 2;
	}
	return true;
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function safeComponent(value: string, allowDots = false): MemoryResult<string> {
	const normalized = value.normalize("NFC");
	if (normalized.length === 0) return invalid("empty component");
	if (!allowDots && (normalized === "." || normalized === "..")) return invalid("traversal component");
	if (normalized.includes("/") || normalized.includes("\\")) return invalid("component contains a path separator");
	if (normalized.includes("\u0000") || normalized.includes("#") || normalized.includes("?")) {
		return invalid("component contains a forbidden character");
	}
	if (/[. ]$/.test(normalized) || WINDOWS_DEVICE_NAME.test(normalized)) return invalid("component is not safe");
	for (const character of normalized) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && codePoint < 0x20) return invalid("component contains a control character");
		if (character === ":") return invalid("component contains a colon");
	}
	if (hasUnpairedSurrogate(normalized)) return invalid("component contains an unpaired surrogate");
	return { ok: true, value: normalized };
}

function decodeComponent(raw: string, kind: "path" | "fragment"): MemoryResult<string> {
	if (raw.length === 0) return invalid(`empty ${kind} component`);
	if (!validPercentEncoding(raw)) return invalid("malformed percent encoding");
	let decoded = raw;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		if (!validPercentEncoding(decoded) || !decoded.includes("%")) break;
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
			if (!/(?:%2e|%2f|%5c|%00)/i.test(decoded)) break;
		} catch {
			return invalid("malformed percent encoding");
		}
	}
	return safeComponent(decoded);
}

function encodeComponent(value: string, kind: "path" | "fragment"): MemoryResult<string> {
	const safe = safeComponent(value);
	if (!safe.ok) return safe;
	try {
		return { ok: true, value: encodeURIComponent(safe.value) };
	} catch {
		return invalid(`cannot encode ${kind} component`);
	}
}

function parsePath(rawPath: string): MemoryResult<readonly string[]> {
	if (rawPath.length === 0) return invalid("path is empty");
	if (rawPath.startsWith("/") || rawPath.endsWith("/") || rawPath.includes("\\") || rawPath.includes("//")) {
		return invalid("path must be relative and POSIX-separated");
	}
	const rawComponents = rawPath.split("/");
	const components: string[] = [];
	for (const rawComponent of rawComponents) {
		const component = decodeComponent(rawComponent, "path");
		if (!component.ok) return component;
		components.push(component.value);
	}
	return { ok: true, value: Object.freeze(components) };
}

function parseFragment(rawFragment: string | null): MemoryResult<string | null> {
	if (rawFragment === null) return { ok: true, value: null };
	if (rawFragment.length === 0) return invalid("fragment is empty");
	const fragment = decodeComponent(rawFragment, "fragment");
	if (!fragment.ok) return fragment;
	return fragment;
}

function canonicalHref(
	scheme: MemoryScopeKind,
	path: readonly string[],
	fragment: string | null,
): MemoryResult<string> {
	const encodedPath: string[] = [];
	for (const component of path) {
		const encoded = encodeComponent(component, "path");
		if (!encoded.ok) return encoded;
		encodedPath.push(encoded.value);
	}
	if (encodedPath.length === 0) return invalid("path is empty");
	if (fragment === null) return { ok: true, value: `${scheme}://${encodedPath.join("/")}` };
	const encodedFragment = encodeComponent(fragment, "fragment");
	if (!encodedFragment.ok) return encodedFragment;
	return { ok: true, value: `${scheme}://${encodedPath.join("/")}#${encodedFragment.value}` };
}

export function parseMemoryUri(raw: string): MemoryResult<MemoryUri> {
	if (typeof raw !== "string") return invalid("URI must be a string");
	const match = /^(global|project|session):\/\/(.*)$/.exec(raw);
	if (match === null) return invalid("scheme must be global://, project://, or session://");
	const scheme = match[1] as MemoryScopeKind;
	const remainder = match[2];
	if (remainder.includes("?")) return invalid("query strings are not supported");
	const fragmentIndex = remainder.indexOf("#");
	const rawPath = fragmentIndex < 0 ? remainder : remainder.slice(0, fragmentIndex);
	const rawFragment = fragmentIndex < 0 ? null : remainder.slice(fragmentIndex + 1);
	const path = parsePath(rawPath);
	if (!path.ok) return path;
	const fragment = parseFragment(rawFragment);
	if (!fragment.ok) return fragment;
	const href = canonicalHref(scheme, path.value, fragment.value);
	if (!href.ok) return href;
	return {
		ok: true,
		value: Object.freeze({
			scheme,
			path: path.value,
			fragment: fragment.value,
			href: href.value,
		}),
	};
}

export function formatMemoryUri(uri: MemoryUri): MemoryResult<string> {
	if (uri === null || typeof uri !== "object" || Array.isArray(uri)) return invalid("URI value must be an object");
	if (!(SCHEMES as readonly string[]).includes(uri.scheme)) return invalid("scheme is unsupported");
	if (!Array.isArray(uri.path) || uri.path.length === 0) return invalid("path is empty");
	const path: string[] = [];
	for (const component of uri.path) {
		if (typeof component !== "string") return invalid("path components must be strings");
		const safe = safeComponent(component);
		if (!safe.ok) return safe;
		path.push(safe.value);
	}
	let fragment: string | null;
	if (uri.fragment === null) {
		fragment = null;
	} else {
		if (typeof uri.fragment !== "string") return invalid("fragment must be a string or null");
		const safeFragment = safeComponent(uri.fragment);
		if (!safeFragment.ok) return safeFragment;
		fragment = safeFragment.value;
	}
	const href = canonicalHref(uri.scheme, path, fragment);
	if (!href.ok) return href;
	if (typeof uri.href === "string" && uri.href.length > 0 && uri.href !== href.value) {
		return invalid("href is not the canonical representation");
	}
	return href;
}
