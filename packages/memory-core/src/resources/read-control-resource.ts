import * as crypto from "node:crypto";

import type { MemoryEnvironment } from "../env";
import { validateMemoryEnvironment } from "../env";
import type { MemoryResult } from "../errors";
import { invalidInput, MEMORY_EXIT_CODES } from "../errors";
import { checkInitializedRoot } from "../policy/initialized";
import { containPath, pinMemoryRoot, validateSafePathComponent } from "../policy/path-safety";
import { openVerifiedFile, VerifiedStorageError } from "../storage/verified-open";

export const CONTROL_RESOURCE_NAMES = Object.freeze(["MEMORY.md", "routes.yaml", "config.yaml"] as const);
export type ControlResourceName =
	| (typeof CONTROL_RESOURCE_NAMES)[number]
	| `projects/${string}/config.yaml`
	| `sessions/${string}/policy.yaml`;

export interface ReadControlResourceResult {
	readonly name: ControlResourceName;
	readonly relPath: ControlResourceName;
	readonly content: string;
	readonly size: number;
	readonly digest: string;
	readonly sha256: string;
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

function errorCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function isControlResourceName(value: unknown): value is ControlResourceName {
	if (typeof value !== "string") return false;
	if ((CONTROL_RESOURCE_NAMES as readonly string[]).includes(value)) return true;
	const parts = value.split("/");
	if (parts.length !== 3 || (parts[0] !== "projects" && parts[0] !== "sessions")) return false;
	const filename = parts[0] === "projects" ? "config.yaml" : "policy.yaml";
	if (parts[2] !== filename) return false;
	const component = parts[1];
	if (component === undefined) return false;
	const validated = validateSafePathComponent(component);
	return validated.ok && validated.value === component;
}

function decodeUtf8(bytes: Buffer, relPath: string): MemoryResult<string> {
	try {
		return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
	} catch {
		return {
			ok: false,
			error: {
				code: "malformed-document",
				exitCode: MEMORY_EXIT_CODES.malformedDocument,
				relPath,
				detail: "control resource is not valid UTF-8",
			},
		};
	}
}

function storageFailure(error: unknown): MemoryResult<never> {
	if (error instanceof VerifiedStorageError) return policyDenied(error.reason);
	return policyDenied(`control resource read failed: ${errorCode(error) ?? "unknown"}`);
}

/**
 * Read one of the fixed control-plane files at the memory-root level, or one
 * policy layer under the admitted project/session component. These files
 * intentionally are not memory documents and therefore do not require
 * frontmatter. The allowlist is exact; callers cannot select an arbitrary path.
 */
export function readControlResource(
	environment: MemoryEnvironment,
	name: string,
): MemoryResult<ReadControlResourceResult> {
	if (!isControlResourceName(name)) return invalidInput("control resource name is not allowlisted");
	const validatedEnvironment = validateMemoryEnvironment(environment);
	if (!validatedEnvironment.ok) return validatedEnvironment;
	const initialized = checkInitializedRoot(validatedEnvironment.value.memoryRoot);
	if (!initialized.ok) return initialized;
	const root = pinMemoryRoot(validatedEnvironment.value.memoryRoot);
	if (!root.ok) return root;
	const contained = containPath(root.value, name, true);
	if (!contained.ok) return contained;
	if (contained.value.leafIdentity === null) {
		return {
			ok: false,
			error: {
				code: "not-found",
				exitCode: MEMORY_EXIT_CODES.notFound,
				uri: name,
			},
		};
	}
	try {
		const bytes = openVerifiedFile(root.value, name);
		const decoded = decodeUtf8(bytes, name);
		if (!decoded.ok) return decoded;
		const digest = crypto.createHash("sha256").update(bytes).digest("hex");
		return {
			ok: true,
			value: Object.freeze({
				name,
				relPath: name,
				content: decoded.value,
				size: bytes.byteLength,
				digest,
				sha256: digest,
			}),
		};
	} catch (error) {
		return storageFailure(error);
	}
}
