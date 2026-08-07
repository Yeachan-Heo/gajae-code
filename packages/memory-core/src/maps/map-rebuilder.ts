import { invalidInput, type MemoryResult } from "../errors";
import type { MemoryIntent } from "../index";
import { normalizeMemoryDocumentUri } from "./map-parser";

const START_PROJECTS = "<!-- AUTO:PROJECTS START -->";
const END_PROJECTS = "<!-- AUTO:PROJECTS END -->";
const START_HEALTH = "<!-- AUTO:INDEX-HEALTH START -->";
const END_HEALTH = "<!-- AUTO:INDEX-HEALTH END -->";

export interface MapRebuildRoute {
	readonly uri: string;
	readonly label?: string;
	readonly aliases?: readonly string[];
	readonly intents?: readonly MemoryIntent[];
	readonly active?: boolean;
	readonly digest?: string;
}

export interface MapRebuildInput {
	readonly content: string;
	readonly routes: readonly MapRebuildRoute[];
	readonly indexHealth?: readonly string[];
}

function invalidMap(detail: string): MemoryResult<never> {
	return invalidInput(`MAP rebuild ${detail}`);
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

interface OriginalMapLine {
	readonly text: string;
	readonly start: number;
	readonly after: number;
}

function originalMapLines(content: string): readonly OriginalMapLine[] {
	const lines: OriginalMapLine[] = [];
	let start = 0;
	for (let index = 0; index < content.length; index += 1) {
		const character = content[index];
		if (character !== "\r" && character !== "\n") continue;
		const separatorLength = character === "\r" && content[index + 1] === "\n" ? 2 : 1;
		lines.push(Object.freeze({ text: content.slice(start, index), start, after: index + separatorLength }));
		start = index + separatorLength;
		index += separatorLength - 1;
	}
	lines.push(Object.freeze({ text: content.slice(start), start, after: content.length }));
	return Object.freeze(lines);
}

function generatedRegion(lines: readonly string[]): string {
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function isControlFree(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) return false;
	}
	return true;
}

function toMemoryUri(raw: string): MemoryResult<string> {
	if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) {
		return invalidMap("route URI is not a non-empty string");
	}
	if (raw.startsWith("memory://")) return normalizeMemoryDocumentUri(raw);
	const match = /^(global|project|session):\/\/(.+)$/u.exec(raw);
	if (match === null) return invalidMap("route URI is not canonical");
	return normalizeMemoryDocumentUri(`memory://${match[1]}/${match[2]}`);
}

function routeLabel(uri: string, label: string | undefined): MemoryResult<string> {
	const candidate = (label ?? uri.split("/").at(-1) ?? "document").normalize("NFC").replace(/\.md(?:#.*)?$/iu, "");
	const normalized = candidate.trim().replace(/\s+/gu, " ");
	if (normalized.length === 0 || !isControlFree(normalized)) return invalidMap("route label is invalid");
	return { ok: true, value: normalized };
}

function annotation(route: MapRebuildRoute): string {
	const aliases = Object.freeze(
		[...(route.aliases ?? [])]
			.map(value => value.normalize("NFC").trim().replace(/\s+/gu, " "))
			.filter(value => value.length > 0 && isControlFree(value))
			.sort(compareUtf8),
	);
	const intents = Object.freeze(
		[...(route.intents ?? [])]
			.map(value => value.normalize("NFC").trim())
			.filter(value => value.length > 0 && isControlFree(value))
			.sort(compareUtf8),
	);
	const values: string[] = [];
	if (aliases.length > 0) values.push(`aliases: ${aliases.join(", ")}`);
	if (intents.length > 0) values.push(`intents: ${intents.join(", ")}`);
	return values.length === 0 ? "" : ` <!-- ${values.join("; ")} -->`;
}

function normalizedRoutes(routes: readonly MapRebuildRoute[]): MemoryResult<readonly MapRebuildRoute[]> {
	if (!Array.isArray(routes)) return invalidMap("routes must be an array");
	const byUri = new Map<string, MapRebuildRoute>();
	for (const route of routes) {
		if (route === null || typeof route !== "object" || Array.isArray(route) || typeof route.uri !== "string") {
			return invalidMap("route entry is malformed");
		}
		const uri = toMemoryUri(route.uri);
		if (!uri.ok) return uri;
		if (route.active === false) {
			byUri.set(uri.value, Object.freeze({ uri: uri.value, active: false }));
			continue;
		}
		if (byUri.get(uri.value)?.active === false) continue;
		const label = routeLabel(uri.value, route.label);
		if (!label.ok) return label;
		byUri.set(
			uri.value,
			Object.freeze({
				uri: uri.value,
				label: label.value,
				aliases: Object.freeze([...(route.aliases ?? [])]),
				intents: Object.freeze([...(route.intents ?? [])]),
				active: true,
				digest: route.digest,
			}),
		);
	}
	const normalized = [...byUri.values()].filter((route): route is MapRebuildRoute => route.active !== false);
	normalized.sort((left, right) => compareUtf8(left.uri, right.uri));
	return { ok: true, value: Object.freeze(normalized) };
}

function markerRegions(lines: readonly string[]): MemoryResult<{
	readonly projectsStart: number;
	readonly projectsEnd: number;
	readonly healthStart: number;
	readonly healthEnd: number;
}> {
	let projectsStart = -1;
	let projectsEnd = -1;
	let healthStart = -1;
	let healthEnd = -1;
	let active: "projects" | "health" | null = null;
	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.trim();
		if (line === START_PROJECTS || line === START_HEALTH) {
			if (active !== null) return invalidMap("contains nested AUTO marker regions");
			if (line === START_PROJECTS) {
				if (projectsStart >= 0) return invalidMap("contains duplicate AUTO:PROJECTS markers");
				projectsStart = index;
				active = "projects";
			} else {
				if (healthStart >= 0) return invalidMap("contains duplicate AUTO:INDEX-HEALTH markers");
				healthStart = index;
				active = "health";
			}
			continue;
		}
		if (line === END_PROJECTS || line === END_HEALTH) {
			if (active === null) return invalidMap("contains an unmatched AUTO marker");
			if (line === END_PROJECTS) {
				if (active !== "projects") return invalidMap("AUTO marker regions are crossed");
				projectsEnd = index;
			} else {
				if (active !== "health") return invalidMap("AUTO marker regions are crossed");
				healthEnd = index;
			}
			active = null;
		}
	}
	if (active !== null) return invalidMap("contains an unterminated AUTO marker region");
	if (projectsStart < 0 || projectsEnd < 0 || healthStart < 0 || healthEnd < 0) {
		return invalidMap("does not contain both approved AUTO marker regions");
	}
	return { ok: true, value: { projectsStart, projectsEnd, healthStart, healthEnd } };
}

function healthLines(routes: readonly MapRebuildRoute[], health: readonly string[] | undefined): readonly string[] {
	const provided = [...(health ?? [])]
		.map(value => String(value).normalize("NFC").replace(/\r\n?/gu, "\n").trim())
		.filter(value => value.length > 0 && isControlFree(value))
		.sort(compareUtf8);
	if (provided.length > 0) return Object.freeze(provided.map(value => `- ${value}`));
	return Object.freeze([`- Active routes: ${routes.length}`]);
}

function rebuild(input: MapRebuildInput): MemoryResult<string> {
	if (input === null || typeof input !== "object" || Array.isArray(input) || typeof input.content !== "string") {
		return invalidMap("input is malformed");
	}
	const content = input.content;
	const originalLines = originalMapLines(content);
	const regions = markerRegions(originalLines.map(line => line.text));
	if (!regions.ok) return regions;
	const routes = normalizedRoutes(input.routes);
	if (!routes.ok) return routes;
	const projectLines = routes.value.map(route => {
		const label = routeLabel(route.uri, route.label);
		if (!label.ok) return "";
		return `[${label.value}](${route.uri})${annotation(route)}`;
	});
	if (projectLines.some(line => line.length === 0)) return invalidMap("route label is invalid");
	const generatedHealth = healthLines(routes.value, input.indexHealth);
	const projectStart = originalLines[regions.value.projectsStart];
	const projectEnd = originalLines[regions.value.projectsEnd];
	const healthStart = originalLines[regions.value.healthStart];
	const healthEnd = originalLines[regions.value.healthEnd];
	if (projectStart === undefined || projectEnd === undefined || healthStart === undefined || healthEnd === undefined) {
		return invalidMap("marker boundaries are unavailable");
	}
	const replacements = [
		{
			start: projectStart.after,
			end: projectEnd.start,
			content: generatedRegion(projectLines),
		},
		{
			start: healthStart.after,
			end: healthEnd.start,
			content: generatedRegion(generatedHealth),
		},
	].sort((left, right) => left.start - right.start);
	let cursor = 0;
	let result = "";
	for (const replacement of replacements) {
		result += content.slice(cursor, replacement.start);
		result += replacement.content;
		cursor = replacement.end;
	}
	result += content.slice(cursor);
	return { ok: true, value: result };
}

export function rebuildMemoryMap(input: MapRebuildInput): MemoryResult<string>;
export function rebuildMemoryMap(
	content: string,
	routes: readonly MapRebuildRoute[],
	indexHealth?: readonly string[],
): MemoryResult<string>;
export function rebuildMemoryMap(
	first: MapRebuildInput | string,
	second?: readonly MapRebuildRoute[],
	third?: readonly string[],
): MemoryResult<string> {
	return typeof first === "string"
		? rebuild({ content: first, routes: second ?? [], indexHealth: third })
		: rebuild(first);
}
