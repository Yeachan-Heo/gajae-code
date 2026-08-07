import type { MemoryResult } from "../errors";
import { invalidInput, MEMORY_EXIT_CODES } from "../errors";
import type { SensitivityFinding } from "../index";

export const SECRET_PATTERN_IDS = Object.freeze({
	keyworded: "keyworded-secret",
	jwtLike: "jwt-like-token",
	aws: "aws-access-key",
	github: "github-token",
} as const);

export type SecretPatternId = (typeof SECRET_PATTERN_IDS)[keyof typeof SECRET_PATTERN_IDS];

export interface SecretFinding extends SensitivityFinding {
	readonly kind: "secret-pattern";
	readonly patternId: SecretPatternId;
}

export interface SecretScanResult {
	readonly findings: readonly SecretFinding[];
	readonly redacted: string;
}

interface SecretPattern {
	readonly id: SecretPatternId;
	readonly expression: RegExp;
}

interface SecretMatch {
	readonly id: SecretPatternId;
	readonly index: number;
}

const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
	{
		id: SECRET_PATTERN_IDS.keyworded,
		expression: /(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/g,
	},
	{
		id: SECRET_PATTERN_IDS.jwtLike,
		// Boundary-anchored on both sides: the unanchored form backtracked
		// catastrophically on long alphanumeric runs (a megabyte of `a` took
		// minutes), which is a denial-of-service risk on any large memory
		// document. Anchoring keeps real JWT detection while staying linear.
		expression: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
	},
	{
		id: SECRET_PATTERN_IDS.aws,
		expression: /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
	},
	{
		id: SECRET_PATTERN_IDS.github,
		expression: /\b(?:gh[opsur]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
	},
]);

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "global-canonical",
			reason,
		},
	};
}

function patternCopy(pattern: SecretPattern): RegExp {
	return new RegExp(pattern.expression.source, pattern.expression.flags);
}

/**
 * Precompute newline offsets once so a scan over a large document stays linear.
 * Looking the line up per match was O(n) each, which made a multi-match scan of a
 * megabyte-scale document effectively hang.
 */
function newlineOffsets(input: string): readonly number[] {
	const offsets: number[] = [];
	for (let cursor = 0; cursor < input.length; cursor += 1) {
		if (input[cursor] === "\n") offsets.push(cursor);
	}
	return offsets;
}

function lineNumberFrom(offsets: readonly number[], index: number): number {
	let low = 0;
	let high = offsets.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const offset = offsets[middle];
		if (offset !== undefined && offset < index) low = middle + 1;
		else high = middle;
	}
	return low + 1;
}

function lineExcerptFrom(offsets: readonly number[], index: number, redactedLines: readonly string[]): string {
	return redactedLines[lineNumberFrom(offsets, index) - 1] ?? "";
}

function redactText(input: string): string {
	let result = input;
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(patternCopy(pattern), "[REDACTED]");
	}
	return result;
}

function scanMatches(input: string): SecretMatch[] {
	const matches: SecretMatch[] = [];
	for (const pattern of SECRET_PATTERNS) {
		const expression = patternCopy(pattern);
		for (;;) {
			const match = expression.exec(input);
			if (match === null) break;
			matches.push({ id: pattern.id, index: match.index });
			if (match[0].length === 0) expression.lastIndex += 1;
		}
	}
	return matches.sort((left, right) => {
		if (left.index !== right.index) return left.index - right.index;
		return Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8"));
	});
}

/** Scan untrusted text and return only redacted, line-addressable findings. */
export function scanSecretContent(input: unknown): MemoryResult<SecretScanResult> {
	if (typeof input !== "string") return invalidInput("secret scanner input must be a string");
	try {
		const normalized = input.normalize("NFC").replace(/\r\n?/g, "\n");
		const matches = scanMatches(normalized);
		const redacted = redactText(normalized);
		const offsets = newlineOffsets(normalized);
		const redactedLines = redacted.split("\n");
		const findings: SecretFinding[] = matches.map(match =>
			Object.freeze({
				kind: "secret-pattern",
				patternId: match.id,
				sensitivity: "restricted",
				line: lineNumberFrom(offsets, match.index),
				excerptRedacted: lineExcerptFrom(offsets, match.index, redactedLines),
			}),
		);
		return {
			ok: true,
			value: Object.freeze({ findings: Object.freeze(findings), redacted }),
		};
	} catch {
		return policyDenied("secret scanner failed closed");
	}
}

export function scanSecretFindings(input: unknown): MemoryResult<readonly SecretFinding[]> {
	const scanned = scanSecretContent(input);
	if (!scanned.ok) return scanned;
	return { ok: true, value: scanned.value.findings };
}

export function redactSecrets(input: unknown): MemoryResult<string> {
	if (typeof input !== "string") return invalidInput("secret scanner input must be a string");
	try {
		return { ok: true, value: redactText(input.normalize("NFC").replace(/\r\n?/g, "\n")) };
	} catch {
		return policyDenied("secret redaction failed closed");
	}
}
