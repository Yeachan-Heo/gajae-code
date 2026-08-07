import type { MemoryResult } from "../errors";
import type { MemoryEnvironment } from "../index";
import { verifyReadAccessGrant } from "../policy/access-policy";
import {
	prepareReadableResource,
	type ResolveReadableResourceInput,
	type ResolveReadableResourceSyncResult,
	readPreparedReadableResource,
} from "./resolve-readable-resource";

/**
 * Resolve one readable markdown document to a verified absolute path. This
 * sibling is restricted to hyperlinking; it never discloses file bytes.
 */
export function resolveReadableResourceSync(
	environment: MemoryEnvironment,
	input: string,
): MemoryResult<ResolveReadableResourceSyncResult>;
export function resolveReadableResourceSync(
	environment: MemoryEnvironment,
	input: ResolveReadableResourceInput,
): MemoryResult<ResolveReadableResourceSyncResult>;
export function resolveReadableResourceSync(
	environment: MemoryEnvironment,
	input: string | ResolveReadableResourceInput,
): MemoryResult<ResolveReadableResourceSyncResult> {
	const prepared = prepareReadableResource(environment, input);
	if (!prepared.ok) return prepared;
	const checked = readPreparedReadableResource(prepared.value);
	if (!checked.ok) return checked;
	const verified = verifyReadAccessGrant(prepared.value.grant, prepared.value.absolutePath, prepared.value.scope);
	if (!verified.ok) return verified;
	return {
		ok: true,
		value: Object.freeze({ absolutePath: verified.value.target }),
	};
}
