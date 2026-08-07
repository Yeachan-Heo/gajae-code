import type { MemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import { type ParsedMemoryMap, parseMemoryMap } from "../maps/map-parser";
import type { DoctorContext, DoctorDocument, DoctorFinding, DoctorMetadata } from "./report";
import { finding, normalizeRelPath, okFindings } from "./report";
import { documentRecords, documentUri, parsedDocumentRecord, parsedRouteConfig } from "./structural";

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

function metadataFor(document: DoctorDocument): DoctorMetadata {
	return document.metadata ?? parsedDocumentRecord(document)?.metadata ?? {};
}

function uriFor(document: DoctorDocument): string | null {
	return documentUri(document);
}

function mapFromContext(context: DoctorContext): ParsedMemoryMap | null {
	const resource = context.map;
	if (resource?.parsed !== undefined && "routes" in resource.parsed) return resource.parsed;
	if (typeof context.mapContent === "string") {
		const parsed = parseMemoryMap(context.mapContent, "MEMORY.md");
		return parsed.ok ? parsed.value : null;
	}
	return null;
}

function activeMapUris(context: DoctorContext): ReadonlySet<string> {
	const map = mapFromContext(context);
	return new Set(map?.routes.map(route => route.uri) ?? context.mapRoutes?.map(route => route.uri) ?? []);
}

function routeIsDefault(context: DoctorContext, uri: string): boolean {
	const parsed = parsedRouteConfig(context);
	if (parsed === null || !parsed.ok) return false;
	if (parsed.value.defaults.some(target => target === uri)) return true;
	return parsed.value.routes.some(route => route.default && route.targets.includes(uri));
}

function sessionDirectoryExists(context: DoctorContext, sessionId: string): boolean {
	const expected = normalizeRelPath(`sessions/${sessionId}`);
	if (expected === null) return false;
	return (context.directories ?? []).some(
		directory => directory.kind !== "symlink" && normalizeRelPath(directory.relPath) === expected,
	);
}

function terminalTaskStillActive(metadata: DoctorMetadata, document: DoctorDocument): boolean {
	if (metadata.type !== "task-state" || metadata.status !== "active") return false;
	if (typeof document.content !== "string") return false;
	return /(?:terminal|state|status)\s*:\s*(?:true|done|completed|complete|closed|terminal)|(?:^|\n)\s*(?:done|completed|complete|closed|terminal)\s*$/imu.test(
		document.content,
	);
}

function supersessionGraph(documents: readonly DoctorDocument[]): ReadonlyMap<string, readonly string[]> {
	const byReference = new Map<string, string>();
	for (const document of documents) {
		const metadata = metadataFor(document);
		const key =
			typeof metadata.id === "string" && metadata.id.length > 0
				? metadata.id.normalize("NFC")
				: uriFor(document)?.normalize("NFC");
		if (key === undefined || key === null || key.length === 0) continue;
		byReference.set(key, key);
	}
	const graph = new Map<string, string[]>();
	for (const document of documents) {
		const metadata = metadataFor(document);
		const key =
			typeof metadata.id === "string" && metadata.id.length > 0
				? metadata.id.normalize("NFC")
				: uriFor(document)?.normalize("NFC");
		if (key === undefined || key === null || key.length === 0) continue;
		const edges: string[] = [];
		for (const target of metadata.supersedes ?? []) {
			if (typeof target !== "string") continue;
			const targetKey = byReference.get(target.normalize("NFC"));
			if (targetKey !== undefined) edges.push(targetKey);
		}
		graph.set(key, edges);
	}
	return graph;
}

function hasSupersessionCycle(graph: ReadonlyMap<string, readonly string[]>): boolean {
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (node: string): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const edge of graph.get(node) ?? []) if (visit(edge)) return true;
		visiting.delete(node);
		visited.add(node);
		return false;
	};
	for (const node of graph.keys()) if (visit(node)) return true;
	return false;
}

function lifecycleFindings(context: DoctorContext): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	const documents = documentRecords(context);
	const routedUris = activeMapUris(context);
	for (const document of documents) {
		const relPath = normalizeRelPath(document.relPath);
		if (relPath === null) continue;
		const metadata = metadataFor(document);
		const uri = uriFor(document);
		if (uri !== null && /^session:\/\/([^/]+)\/checkpoint\.md$/u.test(uri)) {
			const sessionId = /^session:\/\/([^/]+)\//u.exec(uri)?.[1] ?? "";
			if (sessionId.length > 0 && context.directories !== undefined && !sessionDirectoryExists(context, sessionId)) {
				findings.push(
					finding(
						"lifecycle.checkpoint-no-session",
						"error",
						relPath,
						"session checkpoint has no matching session directory",
					),
				);
			}
		}
		if (terminalTaskStillActive(metadata, document)) {
			findings.push(
				finding("lifecycle.terminal-task-active", "error", relPath, "terminal task is still marked active"),
			);
		}
		if (uri !== null && metadata.status === "superseded" && routedUris.has(uri)) {
			findings.push(
				finding(
					"lifecycle.superseded-active-route",
					"error",
					relPath,
					"superseded note is still selected by an active MAP route",
				),
			);
		}
	}
	const graph = supersessionGraph(documents);
	if (hasSupersessionCycle(graph)) {
		const cycleDocument = documents.find(document => typeof metadataFor(document).id === "string");
		findings.push(
			finding(
				"lifecycle.supersession-cycle",
				"error",
				cycleDocument === undefined ? null : normalizeRelPath(cycleDocument.relPath),
				"document supersession references contain a cycle",
			),
		);
	}
	for (const uri of routedUris) {
		if (!uri.includes("/archive/")) continue;
		if (routeIsDefault(context, uri)) {
			findings.push(
				finding(
					"lifecycle.archive-default-route",
					"error",
					"MEMORY.md",
					"archive file is selected by a default MAP route",
				),
			);
		}
	}
	return findings;
}

/** Run lifecycle §28.2 checks over policy-admitted doctor inputs. */
export async function checkLifecycle(
	environment: MemoryEnvironment,
	context: DoctorContext,
): Promise<MemoryResult<readonly DoctorFinding[]>> {
	try {
		if (environment === null || typeof environment !== "object") return invalidInput("memory environment is invalid");
		return okFindings(lifecycleFindings(context));
	} catch {
		return policyDenied("lifecycle doctor checks failed closed");
	}
}
