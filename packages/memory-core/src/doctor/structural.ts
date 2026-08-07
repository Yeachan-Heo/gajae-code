import { type ParsedMemoryDocument, parseMemoryDocument } from "../documents/document-parser";
import { parseMemoryUri } from "../documents/uri";
import type { MemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import { type ParsedMemoryMap, parseMemoryMap } from "../maps/map-parser";
import { parseRoutes, type RouteConfig } from "../maps/route-resolver";
import type { DoctorContext, DoctorDocument, DoctorFinding, DoctorMapResource, DoctorMetadata } from "./report";
import { finding, normalizeRelPath, okFindings } from "./report";

const DOCUMENT_TYPES = new Set([
	"preference",
	"constraint",
	"policy",
	"convention",
	"decision",
	"fact",
	"observation",
	"hypothesis",
	"task-state",
	"handoff",
	"checkpoint",
	"note",
]);
const AUTHORITY_TIERS = new Set([
	"user-confirmed",
	"repository-reviewed",
	"project-config",
	"tool-verified",
	"session-observed",
	"model-inferred",
	"unverified",
]);
const SCOPES = new Set(["global", "project", "session"]);

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "doctor-report",
			reason,
		},
	};
}

function errorDetail(error: unknown): string {
	if (typeof error !== "object" || error === null || !("detail" in error)) return "";
	const detail = (error as { readonly detail?: unknown }).detail;
	return typeof detail === "string" ? detail.normalize("NFC") : "";
}

function classifyDocumentFailure(detail: string): string {
	if (detail.includes("unknown document type")) return "structural.unsupported-type";
	if (detail.includes("unknown authority")) return "structural.unsupported-authority";
	if (detail.includes("unknown document scope")) return "structural.invalid-scope";
	if (detail.includes("URI") || detail.includes("URI".toLowerCase())) return "structural.broken-uri";
	return "structural.malformed-frontmatter";
}

function documentMetadata(document: DoctorDocument, parsed: ParsedMemoryDocument | null): DoctorMetadata {
	if (document.metadata !== undefined) return document.metadata;
	if (parsed === null) return {};
	return parsed.metadata;
}

function parsedDocument(document: DoctorDocument): ParsedMemoryDocument | null {
	if (document.parsed !== undefined) return document.parsed;
	if (typeof document.content !== "string") return null;
	const parsed = parseMemoryDocument({
		content: document.content,
		relPath: document.relPath,
		uri: document.uri ?? undefined,
	});
	return parsed.ok ? parsed.value : null;
}

function parseDocumentResult(document: DoctorDocument): MemoryResult<ParsedMemoryDocument> | null {
	if (document.parsed !== undefined) return { ok: true, value: document.parsed };
	if (typeof document.content !== "string") return null;
	return parseMemoryDocument({ content: document.content, relPath: document.relPath, uri: document.uri ?? undefined });
}

function hasValidMetadata(metadata: DoctorMetadata): boolean {
	if (metadata.type !== undefined && (typeof metadata.type !== "string" || !DOCUMENT_TYPES.has(metadata.type))) {
		return false;
	}
	if (
		metadata.authority !== undefined &&
		(typeof metadata.authority !== "string" || !AUTHORITY_TIERS.has(metadata.authority))
	) {
		return false;
	}
	if (metadata.scope !== undefined && (typeof metadata.scope !== "string" || !SCOPES.has(metadata.scope)))
		return false;
	return true;
}

function mapResource(context: DoctorContext): DoctorMapResource | null {
	if (context.map !== undefined) return context.map;
	if (context.mapContent !== undefined) return { relPath: "MEMORY.md", content: context.mapContent };
	return null;
}

function parsedMap(context: DoctorContext): MemoryResult<ParsedMemoryMap> | null {
	const resource = mapResource(context);
	if (resource === null) return null;
	if (resource.parsed !== undefined) return { ok: true, value: resource.parsed };
	return parseMemoryMap(resource.content ?? "", resource.relPath ?? "MEMORY.md");
}

export function parsedRouteConfig(context: DoctorContext): MemoryResult<RouteConfig> | null {
	if (context.routeConfig !== undefined) return { ok: true, value: context.routeConfig };
	if (context.routes?.parsed !== undefined) return { ok: true, value: context.routes.parsed };
	const content = context.routes?.content ?? context.routesContent;
	if (content === undefined) return null;
	return parseRoutes(content);
}

export function documentRecords(context: DoctorContext): readonly DoctorDocument[] {
	const documents =
		context.documents ??
		(context.files ?? [])
			.filter(file => file.kind === undefined || file.kind === "file")
			.filter(file => file.relPath.toLowerCase().endsWith(".md"));
	return Object.freeze(
		[...documents].sort((left, right) => {
			const leftPath = normalizeRelPath(left.relPath) ?? "";
			const rightPath = normalizeRelPath(right.relPath) ?? "";
			return Buffer.compare(Buffer.from(leftPath, "utf8"), Buffer.from(rightPath, "utf8"));
		}),
	);
}

export function parsedDocumentRecord(document: DoctorDocument): ParsedMemoryDocument | null {
	return parsedDocument(document);
}
export function documentUri(document: DoctorDocument): string | null {
	if (typeof document.uri === "string") return document.uri;
	const parsed = parsedDocument(document);
	if (parsed !== null) return parsed.uri.href;
	const relPath = normalizeRelPath(document.relPath);
	if (relPath === null) return null;
	if (relPath.startsWith("global/")) return `global://${relPath.slice("global/".length)}`;
	if (relPath.startsWith("projects/")) {
		const rest = relPath.slice("projects/".length);
		const slash = rest.indexOf("/");
		if (slash > 0 && slash < rest.length - 1) return `project://${rest}`;
	}
	if (relPath.startsWith("sessions/")) {
		const rest = relPath.slice("sessions/".length);
		const slash = rest.indexOf("/");
		if (slash > 0 && slash < rest.length - 1) return `session://${rest}`;
	}
	return null;
}

function routeUris(map: ParsedMemoryMap | null): ReadonlySet<string> {
	return new Set(map?.routes.map(route => route.uri) ?? []);
}

function mapFailureFinding(resource: DoctorMapResource, detail: string): DoctorFinding {
	if (detail.includes("duplicate document URI")) {
		return finding(
			"structural.duplicate-uri",
			"error",
			resource.relPath ?? "MEMORY.md",
			"MAP contains a duplicate canonical URI",
		);
	}
	if (detail.includes("AUTO marker") || detail.includes("code fence")) {
		return finding(
			"structural.generated-markers",
			"error",
			resource.relPath ?? "MEMORY.md",
			"generated MAP section markers are invalid",
		);
	}
	return finding(
		"structural.broken-map-link",
		"error",
		resource.relPath ?? "MEMORY.md",
		"MAP contains an invalid link or annotation",
	);
}

function structuralFindings(context: DoctorContext): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	const resource = mapResource(context);
	if (resource === null) {
		findings.push(finding("structural.missing-map", "error", "MEMORY.md", "root MAP is missing"));
	}

	const mapResult = parsedMap(context);
	let map: ParsedMemoryMap | null = null;
	if (mapResult !== null) {
		if (!mapResult.ok) {
			findings.push(
				mapFailureFinding(resource ?? { content: "", relPath: "MEMORY.md" }, errorDetail(mapResult.error)),
			);
		} else {
			map = mapResult.value;
		}
	}
	const mapContent = resource?.content;
	if (mapResult?.ok && resource !== null && typeof mapContent === "string") {
		const markers = [
			"<!-- AUTO:PROJECTS START -->",
			"<!-- AUTO:PROJECTS END -->",
			"<!-- AUTO:INDEX-HEALTH START -->",
			"<!-- AUTO:INDEX-HEALTH END -->",
		];
		if (markers.some(marker => !mapContent.includes(marker))) {
			findings.push(
				finding(
					"structural.generated-markers",
					"error",
					resource.relPath ?? "MEMORY.md",
					"generated MAP section markers are invalid",
				),
			);
		}
	}

	const routesResult = parsedRouteConfig(context);
	if (routesResult !== null && !routesResult.ok) {
		findings.push(finding("structural.malformed-yaml", "error", "routes.yaml", "routes YAML is malformed"));
	}

	const documents = documentRecords(context);
	const canonicalUris = new Map<string, string>();
	const routes = routeUris(map);
	for (const document of documents) {
		const relPath = normalizeRelPath(document.relPath);
		if (relPath === null) continue;
		if (document.parseError === true) {
			findings.push(
				finding("structural.malformed-frontmatter", "error", relPath, "document frontmatter is malformed"),
			);
		}
		const result = parseDocumentResult(document);
		if (result !== null && !result.ok) {
			const code = classifyDocumentFailure(errorDetail(result.error));
			findings.push(
				finding(
					code,
					"error",
					relPath,
					code === "structural.unsupported-type"
						? "document type is unsupported"
						: code === "structural.unsupported-authority"
							? "document authority is unsupported"
							: code === "structural.invalid-scope"
								? "document scope is invalid"
								: code === "structural.broken-uri"
									? "document URI is invalid"
									: "document frontmatter is malformed",
				),
			);
		}
		const parsed = result?.ok === true ? result.value : parsedDocument(document);
		const metadata = documentMetadata(document, parsed);
		if (!hasValidMetadata(metadata)) {
			if (metadata.type !== undefined && (typeof metadata.type !== "string" || !DOCUMENT_TYPES.has(metadata.type)))
				findings.push(finding("structural.unsupported-type", "error", relPath, "document type is unsupported"));
			if (
				metadata.authority !== undefined &&
				(typeof metadata.authority !== "string" || !AUTHORITY_TIERS.has(metadata.authority))
			)
				findings.push(
					finding("structural.unsupported-authority", "error", relPath, "document authority is unsupported"),
				);
			if (metadata.scope !== undefined && (typeof metadata.scope !== "string" || !SCOPES.has(metadata.scope)))
				findings.push(finding("structural.invalid-scope", "error", relPath, "document scope is invalid"));
		}
		const rawUri = documentUri(document) ?? document.uri ?? parsed?.uri.href ?? null;
		if (rawUri !== null) {
			const uri = parseMemoryUri(rawUri);
			if (!uri.ok) {
				findings.push(finding("structural.broken-uri", "error", relPath, "document URI is invalid"));
			} else {
				if (typeof metadata.scope === "string" && metadata.scope !== uri.value.scheme)
					findings.push(
						finding("structural.invalid-scope", "error", relPath, "document scope does not match its URI"),
					);
				const prior = canonicalUris.get(uri.value.href);
				if (prior !== undefined)
					findings.push(
						finding("structural.duplicate-uri", "error", relPath, "multiple files use one canonical URI"),
					);
				else canonicalUris.set(uri.value.href, relPath);
				if (map !== null && !routes.has(uri.value.href) && metadata.status === "active")
					findings.push(
						finding(
							"structural.unregistered-note",
							"warning",
							relPath,
							"active canonical note is not registered in the root MAP",
						),
					);
				if (uri.value.scheme === "session" && metadata.type === "note" && !routes.has(uri.value.href))
					findings.push(
						finding(
							"structural.orphan-session-note",
							"warning",
							relPath,
							"session note is not routed by the root MAP",
						),
					);
			}
		}
	}

	if (map !== null) {
		for (const route of map.routes) {
			if (!canonicalUris.has(route.uri)) {
				findings.push(
					finding(
						"structural.broken-map-link",
						"error",
						route.sourceUri === "MEMORY.md" ? "MEMORY.md" : null,
						"MAP route points to a missing canonical note",
					),
				);
			}
		}
	}
	return findings;
}

/** Run structural §28.1 checks over policy-admitted doctor inputs. */
export async function checkStructural(
	environment: MemoryEnvironment,
	context: DoctorContext,
): Promise<MemoryResult<readonly DoctorFinding[]>> {
	try {
		if (environment === null || typeof environment !== "object") return invalidInput("memory environment is invalid");
		return okFindings(structuralFindings(context));
	} catch {
		return policyDenied("structural doctor checks failed closed");
	}
}
