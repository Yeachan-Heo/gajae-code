import type { MemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import { type ParsedMemoryMap, parseMemoryMap } from "../maps/map-parser";
import type { DoctorContext, DoctorDocument, DoctorFinding, DoctorMetadata } from "./report";
import { documentDigest, finding, normalizeRelPath, okFindings } from "./report";
import { documentRecords, documentUri, parsedDocumentRecord } from "./structural";

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
	if (context.map?.parsed !== undefined && "routes" in context.map.parsed) return context.map.parsed;
	if (typeof context.mapContent === "string") {
		const parsed = parseMemoryMap(context.mapContent, "MEMORY.md");
		return parsed.ok ? parsed.value : null;
	}
	return null;
}

function retrievalFindings(context: DoctorContext): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	const documents = documentRecords(context);
	const byUri = new Map<string, DoctorDocument>();
	for (const document of documents) {
		const uri = uriFor(document);
		if (uri !== null) byUri.set(uri, document);
	}
	const map = mapFromContext(context);
	for (const route of map?.routes ?? context.mapRoutes ?? []) {
		if (!byUri.has(route.uri)) {
			findings.push(finding("retrieval.missing-route", "error", "MEMORY.md", "MAP route points to a missing file"));
		}
	}

	const aliases = new Map<string, number>();
	for (const route of map?.routes ?? context.mapRoutes ?? []) {
		for (const alias of route.aliases ?? []) aliases.set(alias, (aliases.get(alias) ?? 0) + 1);
	}
	for (const count of aliases.values()) {
		if (count > 1) {
			findings.push(
				finding(
					"retrieval.alias-ambiguous",
					"warning",
					"MEMORY.md",
					"MAP alias resolves to more than one route without a stable id",
				),
			);
			break;
		}
	}

	for (const generated of context.generatedIndexes ?? []) {
		const relPath = normalizeRelPath(generated.relPath);
		if (generated.digest !== generated.expectedDigest)
			findings.push(
				finding("retrieval.stale-index", "warning", relPath, "generated retrieval index digest is stale"),
			);
	}

	const byDigest = new Map<string, { readonly authority: string | undefined; readonly document: DoctorDocument }>();
	for (const document of documents) {
		const digest = documentDigest(document);
		if (digest === null) continue;
		const metadata = metadataFor(document);
		const prior = byDigest.get(digest);
		if (prior !== undefined && prior.authority !== metadata.authority) {
			findings.push(
				finding(
					"retrieval.duplicate-content",
					"warning",
					normalizeRelPath(document.relPath),
					"identical source content appears under different authority tiers",
				),
			);
			continue;
		}
		byDigest.set(digest, { authority: metadata.authority, document });
	}
	return findings;
}

/** Run retrieval §28.4 checks over policy-admitted doctor inputs. */
export async function checkRetrieval(
	environment: MemoryEnvironment,
	context: DoctorContext,
): Promise<MemoryResult<readonly DoctorFinding[]>> {
	try {
		if (environment === null || typeof environment !== "object") return invalidInput("memory environment is invalid");
		return okFindings(retrievalFindings(context));
	} catch {
		return policyDenied("retrieval doctor checks failed closed");
	}
}
