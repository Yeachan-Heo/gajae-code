import type { MemoryResult } from "../errors";
import { invalidInput, MEMORY_EXIT_CODES } from "../errors";
import type { Sensitivity, SensitivityFinding, WriteDestination } from "../index";

export const WRITE_DESTINATIONS = Object.freeze([
	"global-canonical",
	"project-canonical",
	"session",
	"proposal",
	"checkpoint",
	"ledger",
	"redact-output",
	"export-output",
	"explain-output",
	"doctor-report",
] as const satisfies readonly WriteDestination[]);

export const SENSITIVITY_LEVELS = Object.freeze([
	"public-safe",
	"private",
	"restricted",
] as const satisfies readonly Sensitivity[]);

export interface SensitivityDecision {
	readonly destination: WriteDestination;
	readonly sensitivity: Sensitivity;
	readonly allowed: boolean;
	readonly reason: string;
}

/*
 * The matrix is deliberately explicit. Adding a WriteDestination to index.ts
 * without adding a row here is a type error, rather than an implicit allow.
 */
export const SENSITIVITY_MATRIX: Readonly<Record<WriteDestination, Readonly<Record<Sensitivity, boolean>>>> =
	Object.freeze({
		"global-canonical": Object.freeze({ "public-safe": true, private: true, restricted: true }),
		"project-canonical": Object.freeze({ "public-safe": true, private: true, restricted: true }),
		session: Object.freeze({ "public-safe": true, private: true, restricted: true }),
		proposal: Object.freeze({ "public-safe": true, private: true, restricted: false }),
		checkpoint: Object.freeze({ "public-safe": true, private: true, restricted: false }),
		ledger: Object.freeze({ "public-safe": true, private: false, restricted: false }),
		"redact-output": Object.freeze({ "public-safe": true, private: false, restricted: false }),
		"export-output": Object.freeze({ "public-safe": true, private: false, restricted: false }),
		"explain-output": Object.freeze({ "public-safe": true, private: false, restricted: false }),
		"doctor-report": Object.freeze({ "public-safe": true, private: false, restricted: false }),
	});

function policyDenied(destination: WriteDestination, reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination,
			reason,
		},
	};
}

function sensitivityViolation(
	destination: WriteDestination,
	findings: readonly SensitivityFinding[],
): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "sensitivity-violation",
			exitCode: MEMORY_EXIT_CODES.sensitivityViolation,
			destination,
			findings,
		},
	};
}

function isWriteDestination(value: unknown): value is WriteDestination {
	return typeof value === "string" && (WRITE_DESTINATIONS as readonly string[]).includes(value);
}

function isSensitivity(value: unknown): value is Sensitivity {
	return typeof value === "string" && (SENSITIVITY_LEVELS as readonly string[]).includes(value);
}

function isFinding(value: unknown): value is SensitivityFinding {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const finding = value as {
		readonly kind?: unknown;
		readonly patternId?: unknown;
		readonly sensitivity?: unknown;
		readonly line?: unknown;
		readonly excerptRedacted?: unknown;
	};
	return (
		(finding.kind === "secret-pattern" || finding.kind === "sensitivity-label") &&
		(typeof finding.patternId === "string" || finding.patternId === null) &&
		isSensitivity(finding.sensitivity) &&
		typeof finding.line === "number" &&
		Number.isInteger(finding.line) &&
		finding.line >= 0 &&
		typeof finding.excerptRedacted === "string"
	);
}

function labelFinding(sensitivity: Sensitivity): SensitivityFinding {
	return Object.freeze({
		kind: "sensitivity-label",
		patternId: null,
		sensitivity,
		line: 0,
		excerptRedacted: "[REDACTED]",
	});
}

function hasOverrideField(value: { readonly [key: string]: unknown }): boolean {
	return ["override", "allowSensitive", "allowSecrets", "force"].some(key => Object.hasOwn(value, key));
}

export function sensitivityDecision(destination: WriteDestination, sensitivity: Sensitivity): SensitivityDecision {
	const allowed = SENSITIVITY_MATRIX[destination][sensitivity];
	return Object.freeze({
		destination,
		sensitivity,
		allowed,
		reason: allowed
			? "sensitivity is permitted for the destination"
			: "sensitivity is not permitted for the destination",
	});
}

/**
 * Validate and enforce the immutable destination lattice. There is no override
 * branch: callers that attempt to supply one are denied before content is used.
 */
function checkSensitivityUnchecked(input: unknown): MemoryResult<SensitivityDecision> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return invalidInput("sensitivity policy input must be an object");
	}
	const value = input as { readonly [key: string]: unknown };
	if (hasOverrideField(value)) return policyDenied("global-canonical", "sensitivity overrides are not supported");
	const destination = value.destination;
	const sensitivity = value.sensitivity;
	if (!isWriteDestination(destination)) return invalidInput("write destination is invalid");
	if (!isSensitivity(sensitivity)) return invalidInput("sensitivity is invalid");
	if (value.findings !== undefined) {
		if (!Array.isArray(value.findings) || !value.findings.every(isFinding)) {
			return policyDenied(destination, "sensitivity findings are malformed");
		}
	}
	return { ok: true, value: sensitivityDecision(destination, sensitivity) };
}

export function checkSensitivity(input: unknown): MemoryResult<SensitivityDecision> {
	try {
		return checkSensitivityUnchecked(input);
	} catch {
		return policyDenied("global-canonical", "sensitivity policy failed closed");
	}
}

export function enforceSensitivity(
	destination: unknown,
	sensitivity: unknown,
	findings: readonly SensitivityFinding[] = [],
): MemoryResult<true> {
	const checked = checkSensitivity({ destination, sensitivity, findings });
	if (!checked.ok) return checked;
	const decision = checked.value;
	const secretFindings = findings.filter(finding => finding.kind === "secret-pattern");
	if (secretFindings.length > 0) return sensitivityViolation(decision.destination, secretFindings);
	if (!decision.allowed) {
		const labels = findings.length > 0 ? findings : [labelFinding(decision.sensitivity)];
		return sensitivityViolation(decision.destination, labels);
	}
	return { ok: true, value: true };
}
