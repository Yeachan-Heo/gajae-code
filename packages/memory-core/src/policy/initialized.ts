import * as fs from "node:fs";
import * as path from "node:path";

import type { MemoryResult } from "../errors";
import { invalidInput, MEMORY_EXIT_CODES } from "../errors";

export interface InitializedRoot {
	readonly memoryRoot: string;
}

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

function notInitialized(memoryRoot: string, reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "not-initialized",
			exitCode: MEMORY_EXIT_CODES.notInitialized,
			memoryRoot,
			remedy: reason,
		},
	};
}

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/**
 * Check only whether the supplied root exists as a directory. This gate never
 * creates a directory, reads a scaffold child, or consults configuration.
 */
export function checkInitializedRoot(memoryRoot: unknown): MemoryResult<InitializedRoot> {
	if (typeof memoryRoot !== "string" || memoryRoot.length === 0) {
		return invalidInput("memory root must be a non-empty path");
	}
	if (!path.isAbsolute(memoryRoot) || memoryRoot.includes("\u0000")) {
		return invalidInput("memory root must be an absolute path without NUL");
	}
	try {
		const stat = fs.lstatSync(memoryRoot);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			return notInitialized(memoryRoot, "Run `gjc memory init` to create an initialized memory root.");
		}
		return { ok: true, value: Object.freeze({ memoryRoot }) };
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") {
			return notInitialized(memoryRoot, "Run `gjc memory init` to create an initialized memory root.");
		}
		return policyDenied("memory root could not be inspected");
	}
}
