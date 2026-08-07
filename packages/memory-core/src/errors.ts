import type { ConflictResult, SensitivityFinding, WriteDestination } from "./index";

export const MEMORY_ERROR_SCHEMA_VERSION = "gajae.memory.error.v1" as const;

export const MEMORY_EXIT_CODES = {
	success: 0,
	invalidInput: 2,
	notInitialized: 3,
	scopeUnresolved: 4,
	notFound: 5,
	policyDenied: 6,
	conflictRequiresConfirmation: 7,
	malformedDocument: 8,
	staleSource: 9,
	truncated: 10,
	sensitivityViolation: 11,
	lockConflict: 12,
} as const;

export const EXIT_CODES = MEMORY_EXIT_CODES;

export type MemoryExitCode = (typeof MEMORY_EXIT_CODES)[keyof typeof MEMORY_EXIT_CODES];

export type MemoryError =
	| {
			readonly code: "not-initialized";
			readonly exitCode: 3;
			readonly memoryRoot: string;
			readonly remedy: string;
	  }
	| {
			readonly code: "invalid-input";
			readonly exitCode: 2;
			readonly detail: string;
	  }
	| {
			readonly code: "scope-unresolved";
			readonly exitCode: 4;
			readonly detail: string;
	  }
	| {
			readonly code: "not-found";
			readonly exitCode: 5;
			readonly uri: string;
	  }
	| {
			readonly code: "policy-denied";
			readonly exitCode: 6;
			readonly destination: WriteDestination;
			readonly reason: string;
	  }
	| {
			readonly code: "conflict-requires-confirmation";
			readonly exitCode: 7;
			readonly conflicts: readonly ConflictResult[];
	  }
	| {
			readonly code: "malformed-document";
			readonly exitCode: 8;
			readonly relPath: string;
			readonly detail: string;
	  }
	| {
			readonly code: "stale-source";
			readonly exitCode: 9;
			readonly uri: string;
	  }
	| {
			readonly code: "truncated";
			readonly exitCode: 10;
			readonly detail: string;
	  }
	| {
			readonly code: "sensitivity-violation";
			readonly exitCode: 11;
			readonly destination: WriteDestination;
			readonly findings: readonly SensitivityFinding[];
	  }
	| {
			readonly code: "lock-conflict";
			readonly exitCode: 12;
			readonly relPath: string;
	  };

export type MemoryResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: MemoryError };

export type MemoryErrorEnvelope = { readonly schemaVersion: typeof MEMORY_ERROR_SCHEMA_VERSION } & MemoryError;

export function invalidInput(detail: string): MemoryResult<never> {
	return { ok: false, error: { code: "invalid-input", exitCode: MEMORY_EXIT_CODES.invalidInput, detail } };
}

export function memoryErrorEnvelope(error: MemoryError): MemoryErrorEnvelope {
	return { schemaVersion: MEMORY_ERROR_SCHEMA_VERSION, ...error };
}
