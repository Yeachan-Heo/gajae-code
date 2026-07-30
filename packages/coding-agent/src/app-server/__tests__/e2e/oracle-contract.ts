// The E2E oracle contract.
//
// Every app-server end-to-end tier (G1 component integration, G2 spawned black box, G3a trace
// replay, G3b real client) asserts its frames through THIS module so the tiers cannot drift into
// separately-lenient checkers. The contract is deliberately explicit about what may be
// normalized, because a permissive normalizer is how an e2e suite silently stops testing the
// protocol.

import { experimentalValidators, stableValidators } from "../../protocol-source/schema-validators.generated";

/** How the server under test was reached. Recorded independently of `executionMode`. */
export type TransportMode = "spawned-stdio" | "in-process";

/** What actually executed the work behind the transport. */
export type ExecutionMode = "real-broker-child" | "injected-in-process-session";

/** A tier's status. BLOCKED is a first-class outcome and is never rewritten to pass. */
export type TierStatus = "passed" | "blocked";

export interface TranscriptHeader {
	readonly gateId: string;
	readonly transportMode: TransportMode;
	readonly executionMode: ExecutionMode;
	readonly profile: "stable" | "experimental";
	readonly clientVersion?: string;
}

export interface Frame {
	readonly direction: "outbound" | "inbound";
	readonly method?: string;
	readonly raw: Record<string, unknown>;
}

/**
 * Fields whose VALUES are environment-dependent and may be replaced by a stable placeholder.
 * Nothing else may ever be normalized: a normalizer that touches a method name, an error code,
 * an item type, or a frame's presence would hide exactly the regressions this suite exists for.
 */
export const NORMALIZATION_ALLOWLIST = [
	"cwd",
	"codexHome",
	"path",
	"sourcePath",
	"destinationPath",
	"threadId",
	"sessionId",
	"turnId",
	"itemId",
	"requestId",
	"startedAt",
	"completedAt",
	"createdAt",
	"updatedAt",
	"durationMs",
	"timestamp",
	"loadedAt",
	"version",
	"userAgent",
] as const;

/**
 * Keys that must survive verbatim into the golden bytes. Normalizing any of these is a contract
 * violation, not a convenience: `id` carries request/response correlation, `method` and `code`
 * carry the protocol meaning, and `turn`/`items` carry the shape under test.
 */
export const FORBIDDEN_NORMALIZATIONS = [
	"method",
	"code",
	"jsonrpc",
	"status",
	"type",
	"error",
	"turn",
	"items",
] as const;

const PLACEHOLDER = "<normalized>";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const allowlist = new Set<string>(NORMALIZATION_ALLOWLIST);

/** Replace only allowlisted leaf values, recursively, leaving structure and every other key intact. */
export function normalizeFrame(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeFrame);
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (allowlist.has(key) && (typeof entry === "string" || typeof entry === "number")) out[key] = PLACEHOLDER;
		else out[key] = normalizeFrame(entry);
	}
	return out;
}

/** Deterministic golden bytes: normalized frame with object keys sorted. */
export function goldenBytes(frame: unknown): string {
	const sortDeep = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(sortDeep);
		if (!isRecord(value)) return value;
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map(key => [key, sortDeep(value[key])]),
		);
	};
	return JSON.stringify(sortDeep(normalizeFrame(frame)), null, "\t");
}

export interface OracleViolation {
	readonly rule: string;
	readonly detail: string;
}

/** A JSON-RPC response envelope carries exactly an id plus one of result/error, nothing else. */
export function assertEnvelope(frame: Record<string, unknown>): OracleViolation[] {
	const violations: OracleViolation[] = [];
	const keys = new Set(Object.keys(frame));
	keys.delete("jsonrpc");
	const hasResult = keys.delete("result");
	const hasError = keys.delete("error");
	const hasId = keys.delete("id");
	if (!hasId) violations.push({ rule: "envelope.id", detail: "response frame has no id" });
	if (hasResult === hasError)
		violations.push({ rule: "envelope.resultXorError", detail: "frame must carry exactly one of result/error" });
	for (const extra of keys) violations.push({ rule: "envelope.noExtraKeys", detail: `unexpected key ${extra}` });
	return violations;
}

/** Every response id must correlate to the method of the request that carried that id. */
export function assertCorrelation(
	requests: ReadonlyArray<{ id: string | number; method: string }>,
	responses: ReadonlyArray<Record<string, unknown>>,
): OracleViolation[] {
	const byId = new Map<string, string>(requests.map(request => [String(request.id), request.method]));
	const violations: OracleViolation[] = [];
	const seen = new Set<string>();
	for (const response of responses) {
		const id = response.id === undefined ? undefined : String(response.id);
		if (id === undefined) {
			violations.push({ rule: "correlation.missingId", detail: JSON.stringify(response).slice(0, 120) });
			continue;
		}
		if (!byId.has(id)) violations.push({ rule: "correlation.unknownId", detail: `no request carried id ${id}` });
		if (seen.has(id)) violations.push({ rule: "multiplicity.duplicateResponse", detail: `id ${id} answered twice` });
		seen.add(id);
	}
	for (const [id, method] of byId)
		if (!seen.has(id)) violations.push({ rule: "multiplicity.missingResponse", detail: `${method} (id ${id})` });
	return violations;
}

/** Responses must arrive in the order their requests were issued for a single serial client. */
export function assertOrdering(
	requests: ReadonlyArray<{ id: string | number }>,
	responses: ReadonlyArray<Record<string, unknown>>,
): OracleViolation[] {
	const expected = requests.map(request => String(request.id));
	const actual = responses.map(response => String(response.id));
	if (expected.join(",") === actual.join(",")) return [];
	return [{ rule: "ordering.serialResponses", detail: `expected ${expected.join(",")} got ${actual.join(",")}` }];
}

/** A successful result must satisfy the generated validator for its method and profile. */
export function assertResultShape(
	method: string,
	result: unknown,
	profile: "stable" | "experimental",
): OracleViolation[] {
	const validators = profile === "experimental" ? experimentalValidators : stableValidators;
	const validate = validators.clientRequestResults[method];
	if (!validate) return [{ rule: "validator.missing", detail: `no ${profile} result validator for ${method}` }];
	return validate(result)
		? []
		: [{ rule: "validator.result", detail: `${method} result failed the ${profile} validator` }];
}

export interface TranscriptAssertion {
	readonly header: TranscriptHeader;
	readonly requests: ReadonlyArray<{ id: string | number; method: string }>;
	readonly responses: ReadonlyArray<Record<string, unknown>>;
}

/** Run the whole contract over one transcript. An empty array means the tier is clean. */
export function assertTranscript(transcript: TranscriptAssertion): OracleViolation[] {
	const violations: OracleViolation[] = [
		...assertCorrelation(transcript.requests, transcript.responses),
		...assertOrdering(transcript.requests, transcript.responses),
	];
	const methodById = new Map(transcript.requests.map(request => [String(request.id), request.method]));
	for (const response of transcript.responses) {
		violations.push(...assertEnvelope(response));
		const method = methodById.get(String(response.id));
		if (method !== undefined && response.result !== undefined)
			violations.push(...assertResultShape(method, response.result, transcript.header.profile));
	}
	return violations;
}
