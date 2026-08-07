import { createHash } from "node:crypto";

import type { ParsedMemoryDocument } from "../documents/document-parser";

import { normalizeDocumentText } from "../documents/frontmatter";
import { parseMemoryUri } from "../documents/uri";
import { type MemoryEnvironment, validateMemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryError, type MemoryResult } from "../errors";
import type { ForgetInput, ForgetReceipt, MemoryDocumentType, WriteProposal } from "../index";
import { parseMemoryMap } from "../maps/map-parser";
import { type MapRebuildRoute, rebuildMemoryMap } from "../maps/map-rebuilder";
import type { MemoryPolicyConfig } from "../policy/config-merge";
import {
	admitMemoryPolicy,
	enforceMemorySensitivity,
	enforceMemoryWritePolicy,
	writeDestinationForScope,
} from "../policy/policy-admission";
import { readControlResource } from "../resources/read-control-resource";
import { applyMemory } from "./apply";
import { readInternalLifecycleDocument } from "./internal-document-reader";
import { stageProposal } from "./proposal";
import { buildTombstoneMutation, type SupersededDocumentMutation, type SupersessionCandidate } from "./supersession";

const STRICT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function timestamp(environment: MemoryEnvironment): MemoryResult<string> {
	const candidate = environment.asOf ?? environment.now.toISOString();
	if (!STRICT_UTC.test(candidate) || !Number.isFinite(Date.parse(candidate))) {
		return invalidInput("forget timestamp must be strict UTC");
	}
	return { ok: true, value: candidate };
}

function canonicalUri(raw: string): MemoryResult<string> {
	if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) return invalidInput("forget URI is invalid");
	if (raw.startsWith("memory://")) {
		const rest = raw.slice("memory://".length);
		const hash = rest.indexOf("#");
		const pathPart = hash < 0 ? rest : rest.slice(0, hash);
		const fragment = hash < 0 ? null : rest.slice(hash + 1);
		const pieces = pathPart.split("/");
		if (pieces.length < 2) return invalidInput("forget URI is invalid");
		const normalized = parseMemoryUri(
			`${pieces[0]}://${pieces.slice(1).join("/")}${fragment === null ? "" : `#${fragment}`}`,
		);
		if (!normalized.ok) return invalidInput("forget URI is invalid");
		return { ok: true, value: normalized.value.href };
	}
	const parsed = parseMemoryUri(raw);
	if (!parsed.ok) return parsed;
	return { ok: true, value: parsed.value.href };
}
function documentIdentity(raw: string): MemoryResult<string> {
	const target = raw.startsWith("memory://") ? raw : raw.replace(/^(global|project|session):\/\//u, "memory://$1/");
	const normalized = canonicalUri(target);
	if (!normalized.ok) return invalidInput("forget URI is invalid");
	const fragmentIndex = normalized.value.indexOf("#");
	return {
		ok: true,
		value: fragmentIndex < 0 ? normalized.value : normalized.value.slice(0, fragmentIndex),
	};
}

function relPathForUri(uri: string): MemoryResult<string> {
	const parsed = parseMemoryUri(uri);
	if (!parsed.ok) return parsed;
	const prefix =
		parsed.value.scheme === "global" ? "global" : parsed.value.scheme === "project" ? "projects" : "sessions";
	return { ok: true, value: `${prefix}/${parsed.value.path.join("/")}` };
}

function proposalId(uri: string, content: string, expectedDigest: string, reason: string): string {
	return createHash("sha256")
		.update(Buffer.from(JSON.stringify({ operation: "forget", uri, content, expectedDigest, reason }), "utf8"))
		.digest("hex");
}

function errorAsResult(error: unknown): MemoryResult<never> {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = (error as { readonly code?: unknown }).code;
		if (code === "policy-denied" || code === "sensitivity-violation" || code === "lock-conflict") {
			return { ok: false, error: error as MemoryError };
		}
	}
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "project-canonical",
			reason: "forget failed closed",
		},
	};
}

function mapRoutesAfterForget(mapContent: string, uri: string): MemoryResult<readonly MapRebuildRoute[]> {
	const parsed = parseMemoryMap(mapContent, "memory://global/MEMORY.md");
	if (!parsed.ok) return parsed;
	const target = documentIdentity(uri);
	if (!target.ok) return target;
	const routes: MapRebuildRoute[] = [];
	for (const route of parsed.value.routes) {
		const identity = documentIdentity(route.uri);
		if (!identity.ok) return identity;
		if (identity.value === target.value) continue;
		routes.push(
			Object.freeze({
				uri: route.uri,
				label: route.label,
				aliases: route.aliases,
				intents: route.intents,
				active: true,
			}),
		);
	}
	return { ok: true, value: Object.freeze(routes) };
}

function candidateFromDocument(
	parsed: ParsedMemoryDocument,
	content: string,
	identity: { readonly id: string; readonly supersedes: readonly string[] },
): SupersessionCandidate {
	return Object.freeze({
		uri: parsed.uri.href,
		relPath: parsed.citation.relPath,
		content: normalizeDocumentText(content),
		digest: parsed.digest,
		metadata: parsed.metadata,
		identityId: identity.id,
		supersedes: identity.supersedes,
	});
}

function diffLines(content: string): readonly string[] {
	const normalized = normalizeDocumentText(content).replace(/\n$/u, "");
	return normalized.length === 0 ? [] : normalized.split("\n");
}

function syntheticProposal(
	uri: string,
	relPath: string,
	parsed: ParsedMemoryDocument,
	oldContent: string,
	tombstone: SupersededDocumentMutation,
	reason: string,
): WriteProposal {
	const id = proposalId(uri, tombstone.content, tombstone.expectedDigest, reason);
	const oldLines = diffLines(oldContent);
	const newLines = diffLines(tombstone.content);
	const diff = [
		`--- a/${relPath}`,
		`+++ b/${relPath}`,
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
		...oldLines.map(line => `-${line}`),
		...newLines.map(line => `+${line}`),
		"",
	].join("\n");
	return Object.freeze({
		schemaVersion: "gajae.memory.write-proposal.v1",
		proposalId: id,
		type: parsed.metadata.type as MemoryDocumentType,
		recommendedScope: parsed.metadata.scope,
		recommendedUri: uri,
		recommendedRelPath: relPath,
		requiresApproval: true,
		sourceSession: null,
		diff,
		expectedDigest: tombstone.expectedDigest,
		supersedes: Object.freeze([]),
		sensitivityFindings: Object.freeze([]),
		conflicts: Object.freeze([]),
		mapUpdates: Object.freeze([uri]),
	});
}

export async function forgetMemory(
	environment: MemoryEnvironment,
	input: ForgetInput,
	policy?: MemoryPolicyConfig,
): Promise<MemoryResult<ForgetReceipt>> {
	try {
		const validated = validateMemoryEnvironment(environment);
		if (!validated.ok) return validated;
		const admitted: MemoryResult<MemoryPolicyConfig> =
			policy === undefined ? admitMemoryPolicy(validated.value) : { ok: true, value: policy };
		if (!admitted.ok) return admitted;
		const writeAllowed = enforceMemoryWritePolicy(admitted.value, "global-canonical", "forget");
		if (!writeAllowed.ok) return writeAllowed;
		if (input === null || typeof input !== "object" || Array.isArray(input))
			return invalidInput("forget input must be an object");
		if (typeof input.uri !== "string") return invalidInput("forget URI is required");
		const uri = canonicalUri(input.uri);
		if (!uri.ok) return uri;
		const target = parseMemoryUri(uri.value);
		if (!target.ok) return target;
		const destination = writeDestinationForScope(target.value.scheme);
		const destinationGate = enforceMemoryWritePolicy(admitted.value, destination, "forget");
		if (!destinationGate.ok) return destinationGate;
		const relPath = relPathForUri(uri.value);
		if (!relPath.ok) return relPath;
		const read = await readInternalLifecycleDocument(validated.value, uri.value);
		if (!read.ok) return read;
		const parsed = read.value.parsed;

		const policySensitivity = enforceMemorySensitivity(admitted.value, destination, parsed.metadata.sensitivity);
		if (!policySensitivity.ok) return policySensitivity;
		const actualDigest = parsed.digest;

		if (input.expectedDigest !== undefined && input.expectedDigest !== null) {
			if (typeof input.expectedDigest !== "string" || !/^[0-9a-f]{64}$/u.test(input.expectedDigest)) {
				return invalidInput("forget expectedDigest is invalid");
			}
			if (input.expectedDigest !== actualDigest) {
				return {
					ok: false,
					error: { code: "lock-conflict", exitCode: MEMORY_EXIT_CODES.lockConflict, relPath: relPath.value },
				};
			}
		}
		const time = timestamp(validated.value);
		if (!time.ok) return time;
		if (input.reason !== undefined && typeof input.reason !== "string")
			return invalidInput("forget reason is invalid");
		const reason = input.reason === undefined ? "forgotten" : input.reason.normalize("NFC").trim();
		if (reason.length === 0 || /[\r\n]/u.test(reason)) return invalidInput("forget reason is invalid");
		const candidate = candidateFromDocument(parsed, read.value.content, read.value.identity);

		const tombstone = buildTombstoneMutation(candidate, time.value, reason);
		if (!tombstone.ok) return tombstone;
		const map = readControlResource(validated.value, "MEMORY.md");
		if (!map.ok) return map;
		const routes = mapRoutesAfterForget(map.value.content, uri.value);
		if (!routes.ok) return routes;
		const rebuilt = rebuildMemoryMap({ content: map.value.content, routes: routes.value });
		if (!rebuilt.ok) return rebuilt;
		const proposal = syntheticProposal(uri.value, relPath.value, parsed, read.value.content, tombstone.value, reason);
		const staged = await stageProposal(
			validated.value,
			{
				proposal,
				documentRelPath: relPath.value,
				documentContent: tombstone.value.content,
				superseded: [],
				mapContent: rebuilt.value,
				mapExpectedDigest: map.value.digest,
				mapRoutes: routes.value,
				operation: "forget",
				forgetMarker: tombstone.value.marker,
			},
			admitted.value,
		);
		if (!staged.ok) return staged;
		try {
			const applied = await applyMemory(validated.value, { proposalId: proposal.proposalId }, admitted.value);
			if (!applied.ok) return applied;
			return {
				ok: true,
				value: Object.freeze({
					schemaVersion: "gajae.memory.forget-receipt.v1",
					uri: uri.value,
					forgotten: applied.value.applied,
					superseded: true,
					marker: tombstone.value.marker,
				}),
			};
		} catch (error) {
			return errorAsResult(error);
		}
	} catch (error) {
		return errorAsResult(error);
	}
}
